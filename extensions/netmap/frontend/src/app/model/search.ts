import { GraphNode } from './api-types';
import { parseV4 } from './cidr';
import { GraphIndex, str, strs } from './graph-index';
import { kindInfo } from './kinds';

// Find-anything box over one snapshot graph: ids, names, IPs, CIDRs and DNS names; pods / tasks / functions by name,
// namespace/name (their native id), pod or task IP and container image; ingresses by host. Framework-free.

export interface SearchHit {
  nodeId: string;
  label: string;
  sub: string;
  why: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const DOMAIN = /^(?=.*[a-z])[a-z0-9_-]+(\.[a-z0-9_-]+)+\.?$/i;

export function search(idx: GraphIndex, text: string, limit = 25): SearchHit[] {
  const q = text.trim();
  if (!q) return [];
  const scored = new Map<string, { score: number; why: string }>();
  const add = (n: GraphNode | undefined, score: number, why: string): void => {
    if (!n) return;
    const cur = scored.get(n.id);
    if (!cur || cur.score < score) scored.set(n.id, { score, why });
  };

  if (IPV4.test(q)) searchIp(idx, q, add);
  else if (CIDR.test(q)) searchCidr(idx, q, add);
  if (DOMAIN.test(q) && !IPV4.test(q)) searchDomain(idx, q, add);
  searchText(idx, q, add);

  return [...scored.entries()]
    .map(([id, s]) => ({ n: idx.node(id)!, ...s }))
    .sort((a, b) => b.score - a.score || kindInfo(a.n.kind).level - kindInfo(b.n.kind).level || (a.n.name || '').localeCompare(b.n.name || ''))
    .slice(0, limit)
    .map(({ n, why }) => ({ nodeId: n.id, label: n.name || n.nativeId, sub: subOf(idx, n), why }));
}

type Add = (n: GraphNode | undefined, score: number, why: string) => void;

function subOf(idx: GraphIndex, n: GraphNode): string {
  const net = n.kind === 'network' ? undefined : idx.ancestorOfKind(n.id, 'network');
  return [kindInfo(n.kind).label, n.nativeId !== n.name ? n.nativeId : '', net ? net.name || net.nativeId : ''].filter(Boolean).join(' · ');
}

function searchIp(idx: GraphIndex, ip: string, add: Add): void {
  const one = parseV4(`${ip}/32`);
  if (!one) return;
  for (const n of idx.graph.nodes) {
    const a = n.attrs ?? {};
    if (n.kind === 'network-interface') {
      if (str(a['privateIp']) === ip || strs(a['privateIps']).includes(ip)) add(n, 120, `private IP ${ip}`);
      if (str(a['publicIp']) === ip) add(n, 115, `public IP ${ip}`);
    } else if (n.kind === 'pod') {
      if (str(a['podIp']) === ip || strs(a['podIps']).includes(ip)) add(n, 125, `pod IP ${ip}`);
    } else if (n.kind === 'ecs-task') {
      if (str(a['privateIp']) === ip) add(n, 124, `task IP ${ip}`);
    } else if (n.kind === 'k8s-service') {
      if (str(a['clusterIp']) === ip) add(n, 105, `cluster IP ${ip}`);
    } else if (str(a['ip']) === ip || str(a['outsideIp']) === ip) add(n, 110, `address ${ip}`);
    else if (n.kind === 'nat-gateway' && strs(a['privateIps']).includes(ip)) add(n, 110, `private IP ${ip}`);
  }
  // the smallest subnet that contains it, then its network
  let best: { n: GraphNode; size: number } | undefined;
  for (const n of idx.graph.nodes) {
    if (n.kind !== 'subnet' && n.kind !== 'network') continue;
    for (const c of n.cidrs ?? []) {
      const r = parseV4(c);
      if (!r || r[0] > one[0] || r[1] < one[0]) continue;
      const size = r[1] - r[0];
      if (n.kind === 'subnet' && (!best || size < best.size)) best = { n, size };
      if (n.kind === 'network') add(n, 60, `${c} contains ${ip}`);
    }
  }
  if (best) add(best.n, 80, `${best.n.cidrs?.[0]} contains ${ip}`);
}

function searchCidr(idx: GraphIndex, cidr: string, add: Add): void {
  const q = parseV4(cidr);
  if (!q) return;
  for (const n of idx.graph.nodes) {
    for (const c of n.cidrs ?? []) {
      const r = parseV4(c);
      if (!r) continue;
      if (r[0] === q[0] && r[1] === q[1]) add(n, n.kind === 'subnet' || n.kind === 'network' ? 120 : 100, `CIDR ${c}`);
      else if (r[0] <= q[0] && q[1] <= r[1] && (n.kind === 'subnet' || n.kind === 'network')) add(n, 70, `${c} contains ${cidr}`);
      else if (q[0] <= r[0] && r[1] <= q[1] && (n.kind === 'subnet' || n.kind === 'network')) add(n, 65, `${c} is inside ${cidr}`);
    }
  }
}

function normDns(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, '').replace(/^dualstack\./, '');
}

function searchDomain(idx: GraphIndex, domain: string, add: Add): void {
  const q = normDns(domain);
  let anyRecord = false;
  for (const rec of idx.ofKind('dns-record')) {
    if (normDns(rec.name) !== q) continue;
    anyRecord = true;
    add(rec, 105, `DNS record ${rec.name}`);
    for (const e of idx.out(rec.id, 'resolves-to')) add(idx.node(e.to), 125, `${rec.name} resolves here`);
  }
  for (const lb of idx.ofKind('load-balancer')) {
    const dns = str(lb.attrs?.['dnsName']);
    if (dns && normDns(dns) === q) add(lb, 125, `DNS name ${dns}`);
  }
  // Kubernetes: ingress rule hosts, and load balancer hostnames in service / ingress status
  for (const n of [...idx.ofKind('ingress'), ...idx.ofKind('k8s-service')]) {
    const rules = Array.isArray(n.attrs?.['rules']) ? (n.attrs!['rules'] as { host?: string }[]) : [];
    if (rules.some(r => r.host && normDns(r.host) === q)) add(n, 125, `ingress host ${q}`);
    else if (strs(n.attrs?.['lbHostnames']).some(h => normDns(h) === q)) add(n, 115, `load balancer hostname ${q}`);
  }
  if (anyRecord) return;
  for (const z of idx.ofKind('dns-zone')) {
    const zn = normDns(z.name);
    if (q === zn || q.endsWith(`.${zn}`)) add(z, 90 + zn.length / 100, `in zone ${z.name}`);
  }
}

function searchText(idx: GraphIndex, q: string, add: Add): void {
  const lq = q.toLowerCase();
  for (const n of idx.graph.nodes) {
    const name = (n.name ?? '').toLowerCase();
    const native = n.nativeId.toLowerCase();
    if (native === lq) add(n, 130, 'id');
    else if (name === lq) add(n, 100, 'name');
    else if (name.startsWith(lq)) add(n, 75, 'name starts with');
    else if (native.startsWith(lq)) add(n, 70, 'id starts with');
    else if (name.includes(lq)) add(n, 45, 'name contains');
    else if (native.includes(lq)) add(n, 40, 'id contains');
    else if (lq.length >= 3 && (n.kind === 'pod' || n.kind === 'ecs-task') && strs(n.attrs?.['images']).some(i => i.toLowerCase().includes(lq))) {
      add(n, 35, `image ${strs(n.attrs?.['images']).find(i => i.toLowerCase().includes(lq))}`);
    } else if (lq.length >= 3) {
      const tag = Object.entries(n.tags ?? {}).find(([k, v]) => v.toLowerCase().includes(lq) || k.toLowerCase() === lq);
      if (tag) add(n, 20, `tag ${tag[0]}=${tag[1]}`);
    }
  }
}
