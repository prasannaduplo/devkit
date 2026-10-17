import { GraphNode, Json } from './api-types';
import { parseV4 } from './cidr';
import { GraphIndex, str, strs } from './graph-index';

// Workload identity helpers for the path engine (v2b): which address a pod / ECS task / Lambda sends from, which
// pods sit behind a Kubernetes service or ingress, and Kubernetes NetworkPolicy evaluation. Framework-free.

export type Range = [number, number];
const ALL: Range = [0, 4294967295];

export const WORKLOAD_KINDS = new Set(['pod', 'ecs-task', 'lambda-function']);
export const FRONT_KINDS = new Set(['k8s-service', 'ingress']);

/** The address a workload uses: pod IP, task IP; undefined for others (use the interface's). */
export function workloadIp(n: GraphNode): string | undefined {
  if (n.kind === 'pod') return str(n.attrs?.['podIp']);
  if (n.kind === 'ecs-task') return str(n.attrs?.['privateIp']);
  return undefined;
}

/** Pods behind a service (selects) or an ingress (backs → service → selects), sorted by name. */
export function podsBehind(idx: GraphIndex, n: GraphNode): GraphNode[] {
  const services = n.kind === 'ingress'
    ? idx.out(n.id, 'backs').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'k8s-service')
    : n.kind === 'k8s-service' ? [n] : [];
  const pods = new Map<string, GraphNode>();
  for (const s of services) for (const e of idx.out(s.id, 'selects')) { const p = idx.node(e.to); if (p?.kind === 'pod') pods.set(p.id, p); }
  return [...pods.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Load balancers fronting a service or ingress (backs), including those of the ingress's services. */
export function lbsOf(idx: GraphIndex, n: GraphNode): GraphNode[] {
  const out = new Map<string, GraphNode>();
  const take = (id: string) => { for (const e of idx.out(id, 'backs')) { const t = idx.node(e.to); if (t?.kind === 'load-balancer') out.set(t.id, t); } };
  take(n.id);
  if (n.kind === 'ingress') for (const e of idx.out(n.id, 'backs')) take(e.to);
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// label selectors

type Labels = Record<string, string>;

export function labelsOf(n: GraphNode | undefined): Labels {
  const l = n?.attrs?.['labels'];
  return l && typeof l === 'object' && !Array.isArray(l) ? Object.fromEntries(Object.entries(l).filter(([, v]) => typeof v === 'string')) as Labels : {};
}

/** Kubernetes semantics: matchLabels AND matchExpressions; an empty selector matches everything. */
export function selectorMatches(sel: Json | undefined, labels: Labels): boolean {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return false;
  const ml = sel['matchLabels'];
  if (ml && typeof ml === 'object' && !Array.isArray(ml)) for (const [k, v] of Object.entries(ml)) if (labels[k] !== v) return false;
  const me = sel['matchExpressions'];
  if (Array.isArray(me)) {
    for (const x of me as Record<string, Json>[]) {
      const key = String(x['key'] ?? '');
      const values = strs(x['values']);
      const has = key in labels;
      const ok = x['operator'] === 'In' ? has && values.includes(labels[key])
        : x['operator'] === 'NotIn' ? !has || !values.includes(labels[key])
        : x['operator'] === 'Exists' ? has
        : x['operator'] === 'DoesNotExist' ? !has : false;
      if (!ok) return false;
    }
  }
  return true;
}

function selectorText(sel: Json | undefined): string {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return '';
  const parts: string[] = [];
  const ml = sel['matchLabels'];
  if (ml && typeof ml === 'object' && !Array.isArray(ml)) for (const [k, v] of Object.entries(ml)) parts.push(`${k}=${v}`);
  if (Array.isArray(sel['matchExpressions'])) for (const x of sel['matchExpressions'] as Record<string, Json>[]) parts.push(`${x['key']} ${x['operator']} ${strs(x['values']).join('|')}`.trim());
  return parts.length ? parts.join(',') : 'all';
}

// ---------------------------------------------------------------------------------------------------------------
// NetworkPolicy

export const NP_ENGINE_NOTE = ' (enforced only if the cluster runs a NetworkPolicy engine)';

export interface Peer {
  /** The other end's address range; null when not known. */
  range: Range | null;
  /** The other end when it is a pod in the graph (selectors can match it). */
  pod?: GraphNode;
}

export interface NpVerdict { verdict: 'allow' | 'block' | 'unknown' | 'info'; nodeId: string; reason: string; rule?: string }

interface Traffic { proto: string; port: number }

const contains = (o: Range, i: Range) => o[0] <= i[0] && i[1] <= o[1];
const overlaps = (a: Range, b: Range) => a[0] <= b[1] && b[0] <= a[1];
const PRIVATE: Range[] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16'].map(c => parseV4(c)!);
const isPrivate = (r: Range) => PRIVATE.some(p => contains(p, r));

/** Policies selecting the pod that govern this direction. */
export function policiesFor(idx: GraphIndex, pod: GraphNode, dir: 'ingress' | 'egress'): GraphNode[] {
  const type = dir === 'ingress' ? 'Ingress' : 'Egress';
  return idx.in(pod.id, 'selects').map(e => idx.node(e.from))
    .filter((x): x is GraphNode => x?.kind === 'network-policy' && strs(x.attrs?.['policyTypes']).includes(type));
}

function namespaceOf(idx: GraphIndex, pod: GraphNode): GraphNode | undefined {
  return idx.ancestorOfKind(pod.id, 'k8s-namespace');
}

/** ipBlock: true/false, or null when it depends on what is not known. */
function ipBlockMatches(block: Record<string, Json>, range: Range | null): boolean | null {
  const cidr = parseV4(String(block['cidr'] ?? ''));
  if (!cidr) return null;
  if (!range) return null;
  // not covered: false; a partly covered source range (a whole subnet) cannot be decided
  if (!contains(cidr, range)) return overlaps(cidr, range) && !(range[0] === ALL[0] && range[1] === ALL[1]) ? null : false;
  for (const ex of strs(block['except'])) {
    const er = parseV4(ex);
    if (!er) continue;
    if (contains(er, range)) return false;
    // "the internet" is any public address: an except that is private does not take it away
    if (overlaps(er, range) && !(range[0] === ALL[0] && range[1] === ALL[1] && isPrivate(er))) return null;
  }
  return true;
}

function peerMatches(idx: GraphIndex, pol: GraphNode, p: Record<string, Json>, peer: Peer): boolean | null {
  if (p['ipBlock'] && typeof p['ipBlock'] === 'object') return ipBlockMatches(p['ipBlock'] as Record<string, Json>, peer.range);
  // podSelector / namespaceSelector match only pods
  if (!peer.pod) return peer.range ? false : null;
  const polNs = str(pol.attrs?.['namespace']);
  const ns = namespaceOf(idx, peer.pod);
  const nsOk = p['namespaceSelector'] !== undefined
    ? selectorMatches(p['namespaceSelector'], labelsOf(ns))
    : str(peer.pod.attrs?.['namespace']) === polNs;
  const podOk = p['podSelector'] !== undefined ? selectorMatches(p['podSelector'], labelsOf(peer.pod)) : true;
  return nsOk && podOk;
}

function portMatches(ports: Json | undefined, t: Traffic): boolean | null {
  if (!Array.isArray(ports) || ports.length === 0) return true;
  let unknown = false;
  for (const p of ports as Record<string, Json>[]) {
    const proto = String(p['protocol'] ?? 'TCP').toLowerCase();
    if (t.proto !== 'all' && proto !== t.proto) continue;
    if (p['port'] === undefined) return true;
    if (typeof p['port'] === 'string') { unknown = true; continue; }   // named container port: not resolvable here
    const from = Number(p['port']);
    const to = typeof p['endPort'] === 'number' ? p['endPort'] : from;
    if (t.proto === 'all') { unknown = true; continue; }
    if (t.port >= from && t.port <= to) return true;
  }
  return unknown ? null : false;
}

function ruleText(pol: GraphNode, dir: 'ingress' | 'egress', rule: Record<string, Json>): string {
  const peers = rule[dir === 'egress' ? 'to' : 'from'];
  const peerText = Array.isArray(peers) && peers.length
    ? (peers as Record<string, Json>[]).map(p => {
      if (p['ipBlock'] && typeof p['ipBlock'] === 'object') {
        const b = p['ipBlock'] as Record<string, Json>;
        const ex = strs(b['except']);
        return `ipBlock ${b['cidr']}${ex.length ? ` except ${ex.join(', ')}` : ''}`;
      }
      return [p['namespaceSelector'] !== undefined ? `namespaces(${selectorText(p['namespaceSelector'])})` : '', p['podSelector'] !== undefined ? `pods(${selectorText(p['podSelector'])})` : ''].filter(Boolean).join(' ');
    }).join(' | ')
    : 'anywhere';
  const ports = rule['ports'];
  const portText = Array.isArray(ports) && ports.length
    ? (ports as Record<string, Json>[]).map(p => `${p['protocol'] ?? 'TCP'}/${p['port'] ?? 'all'}${typeof p['endPort'] === 'number' ? `-${p['endPort']}` : ''}`).join(', ')
    : 'all ports';
  return `${pol.name}: ${dir} ${dir === 'egress' ? 'to' : 'from'} ${peerText} on ${portText}`;
}

/** Evaluate the NetworkPolicies selecting `pod` for traffic in `dir` with `peer`. Null when no policy governs it. */
export function evalNetworkPolicy(idx: GraphIndex, pod: GraphNode, dir: 'ingress' | 'egress', peer: Peer, t: Traffic): NpVerdict | null {
  const pols = policiesFor(idx, pod, dir);
  if (!pols.length) return null;
  let maybe: { pol: GraphNode; text: string } | undefined;
  for (const pol of pols) {
    const rules = pol.attrs?.[dir];
    for (const r of Array.isArray(rules) ? (rules as Record<string, Json>[]) : []) {
      const pm = portMatches(r['ports'], t);
      if (pm === false) continue;
      const peers = r[dir === 'egress' ? 'to' : 'from'];
      let peerOk: boolean | null = false;
      if (!Array.isArray(peers) || peers.length === 0) peerOk = true;
      else for (const p of peers as Record<string, Json>[]) {
        const m = peerMatches(idx, pol, p, peer);
        if (m === true) { peerOk = true; break; }
        if (m === null) peerOk = null;
      }
      if (peerOk === true && pm === true) return { verdict: 'allow', nodeId: pol.id, reason: `NetworkPolicy ${pol.name} allows it${NP_ENGINE_NOTE}.`, rule: ruleText(pol, dir, r) };
      if (!maybe && (peerOk === null || (peerOk === true && pm === null))) maybe = { pol, text: ruleText(pol, dir, r) };
    }
  }
  if (maybe) {
    return { verdict: 'unknown', nodeId: maybe.pol.id, rule: maybe.text,
      reason: `A rule of ${maybe.pol.name} may allow it, but ${peer.range ? 'it uses a named port or a selector that cannot be decided here' : 'the other end’s address is not known'}${NP_ENGINE_NOTE}.` };
  }
  return { verdict: 'block', nodeId: pols[0].id,
    reason: `Selected by ${pols.map(p => p.name).join(', ')} (policyTypes ${dir === 'egress' ? 'Egress' : 'Ingress'}); no rule allows it${NP_ENGINE_NOTE}.` };
}
