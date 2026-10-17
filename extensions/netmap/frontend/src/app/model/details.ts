import { GraphEdge, GraphNode, Json } from './api-types';
import { GraphIndex, num, str, strs } from './graph-index';
import { kindInfo } from './kinds';

/** A small table shown in the side panel for the selected node: routes, security group rules, NACL entries… */
export interface DetailSection {
  title: string;
  columns: string[];
  rows: DetailRow[];
  empty?: string;
}

export interface DetailRow {
  cells: string[];
  /** Node to reveal on the map when the row is clicked. */
  nodeId?: string;
  tone?: 'ok' | 'warn' | 'bad' | 'muted';
}

const prefixLen = (cidr: string): number => {
  const m = /\/(\d+)$/.exec(cidr);
  return m ? Number(m[1]) : -1;
};

const label = (n: GraphNode | undefined, fallbackId: string): string =>
  n ? n.name || n.nativeId : fallbackId.split(':').slice(4).join(':') || fallbackId;

function routeRows(idx: GraphIndex, rt: GraphNode): DetailRow[] {
  const rows: (DetailRow & { sort: number })[] = [];
  const network = idx.ancestorOfKind(rt.id, 'network');
  // the VPC "local" route is implicit in AWS and not emitted as an edge
  if (rt.kind === 'route-table') for (const c of network?.cidrs ?? []) rows.push({ cells: [c, 'local', 'active', 'implicit'], sort: 1000 + prefixLen(c), tone: 'muted' });
  for (const e of idx.out(rt.id, 'routes-to')) {
    const dest = str(e.attrs?.['destination']) ?? '';
    const pl = (e.attrs?.['prefixListCidrs'] as string[] | undefined) ?? [];
    const target = idx.node(e.to);
    const state = str(e.attrs?.['state']) ?? 'active';
    rows.push({
      cells: [pl.length ? `${dest} (${pl.length} CIDRs)` : dest, `${label(target, e.to)}${target ? ` · ${kindInfo(target.kind).label}` : ''}`, state, str(e.attrs?.['origin']) ?? ''],
      nodeId: target ? e.to : undefined,
      tone: state === 'blackhole' ? 'bad' : undefined,
      sort: prefixLen(dest),
    });
  }
  // most specific first, as the router evaluates them
  return rows.sort((a, b) => b.sort - a.sort).map(({ sort: _s, ...r }) => r);
}

function portText(e: GraphEdge): string {
  const proto = str(e.attrs?.['protocol']) ?? 'all';
  const from = num(e.attrs?.['fromPort']) ?? -1;
  const to = num(e.attrs?.['toPort']) ?? -1;
  if (proto === 'all' || proto === '-1') return 'all traffic';
  if (from < 0) return `${proto} all`;
  return from === to ? `${proto}/${from}` : `${proto}/${from}-${to}`;
}

function peerText(n: GraphNode | undefined, id: string): string {
  if (!n) return label(n, id);
  if (n.kind === 'external') return n.cidrs?.length ? n.cidrs.join(', ') : '0.0.0.0/0 (internet)';
  if (n.kind === 'cidr-block') return n.cidrs?.join(', ') || n.name;
  return `${n.name} (${kindInfo(n.kind).label})`;
}

function sgRows(idx: GraphIndex, sg: GraphNode, dir: 'ingress' | 'egress'): DetailRow[] {
  const edges = dir === 'ingress' ? idx.in(sg.id, 'allows') : idx.out(sg.id, 'allows');
  return edges
    .filter(e => (str(e.attrs?.['direction']) ?? dir) === dir)
    .map(e => {
      const peerId = dir === 'ingress' ? e.from : e.to;
      const peer = idx.node(peerId);
      const wide = peer?.kind === 'external' && dir === 'ingress';
      return {
        cells: [portText(e), peerText(peer, peerId), str(e.attrs?.['description']) ?? ''],
        nodeId: peer && peer.kind !== 'external' && peer.kind !== 'cidr-block' ? peerId : undefined,
        tone: wide ? ('warn' as const) : undefined,
      };
    });
}

const NACL_PROTO: Record<string, string> = { '-1': 'all', '6': 'tcp', '17': 'udp', '1': 'icmp' };

function naclRows(nacl: GraphNode, egress: boolean): DetailRow[] {
  const entries = ((nacl.raw as any)?.Entries ?? []) as any[];
  return entries
    .filter(x => !!x.Egress === egress)
    .sort((a, b) => (a.RuleNumber ?? 0) - (b.RuleNumber ?? 0))
    .map(x => {
      const proto = NACL_PROTO[String(x.Protocol)] ?? String(x.Protocol);
      const ports = x.PortRange ? (x.PortRange.From === x.PortRange.To ? `${x.PortRange.From}` : `${x.PortRange.From}-${x.PortRange.To}`) : 'all';
      const allow = String(x.RuleAction).toLowerCase() === 'allow';
      return {
        cells: [x.RuleNumber === 32767 ? '*' : String(x.RuleNumber), proto, proto === 'all' ? 'all' : ports, x.CidrBlock ?? x.Ipv6CidrBlock ?? '', allow ? 'allow' : 'deny'],
        tone: allow ? undefined : ('bad' as const),
      };
    });
}

function usedBy(idx: GraphIndex, n: GraphNode): DetailRow[] {
  return idx.in(n.id, 'associated')
    .map(e => ({ e, s: idx.node(e.from) }))
    .filter(x => x.s?.kind === 'subnet')
    .map(({ e, s }) => ({ cells: [s!.name, s!.cidrs?.join(', ') ?? '', e.attrs?.['implicit'] ? 'main (implicit)' : 'explicit'], nodeId: s!.id }));
}

// ---- workloads (v2b) -------------------------------------------------------------------------------------------

type Obj = Record<string, Json>;
const objs = (v: Json | undefined): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const mapText = (v: Json | undefined): string =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join(', ') : '';

function selectorText(sel: Json | undefined): string {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return '—';
  const parts = [mapText(sel['matchLabels'])].filter(Boolean);
  for (const x of objs(sel['matchExpressions'])) parts.push(`${x['key']} ${x['operator']} ${strs(x['values']).join('|')}`.trim());
  return parts.join(', ') || 'all pods';
}

function podRows(idx: GraphIndex, ids: string[]): DetailRow[] {
  return ids.map(id => idx.node(id)).filter((p): p is GraphNode => !!p)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(p => ({ cells: [p.name, str(p.attrs?.['podIp']) ?? '', str(p.attrs?.['phase']) ?? ''], nodeId: p.id,
      tone: (str(p.attrs?.['phase']) ?? 'Running') !== 'Running' ? ('warn' as const) : undefined }));
}

function lbRows(idx: GraphIndex, n: GraphNode): DetailRow[] {
  return idx.out(n.id, 'backs').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'load-balancer')
    .map(lb => ({ cells: [lb.name, str(lb.attrs?.['scheme']) ?? '', str(lb.attrs?.['dnsName']) ?? ''], nodeId: lb.id,
      tone: str(lb.attrs?.['scheme']) === 'internet-facing' ? ('warn' as const) : undefined }));
}

function npPeerText(p: Obj): string {
  if (p['ipBlock'] && typeof p['ipBlock'] === 'object') {
    const b = p['ipBlock'] as Obj;
    const ex = strs(b['except']);
    return `ipBlock ${b['cidr']}${ex.length ? ` except ${ex.join(', ')}` : ''}`;
  }
  return [p['namespaceSelector'] !== undefined ? `namespaces: ${selectorText(p['namespaceSelector'])}` : '',
    p['podSelector'] !== undefined ? `pods: ${selectorText(p['podSelector'])}` : ''].filter(Boolean).join(' · ') || '—';
}

function policyRows(n: GraphNode, dir: 'ingress' | 'egress'): DetailRow[] {
  return objs(n.attrs?.[dir]).map((r, i) => {
    const peers = objs(r[dir === 'egress' ? 'to' : 'from']);
    const ports = objs(r['ports']).map(p => `${p['protocol'] ?? 'TCP'}/${p['port'] ?? 'all'}${typeof p['endPort'] === 'number' ? `-${p['endPort']}` : ''}`);
    return { cells: [String(i + 1), peers.length ? peers.map(npPeerText).join(' | ') : 'anywhere', ports.join(', ') || 'all ports'] };
  });
}

function workloadSections(idx: GraphIndex, n: GraphNode): DetailSection[] | null {
  const a = n.attrs ?? {};
  switch (n.kind) {
    case 'k8s-service':
      return [
        { title: 'Ports', columns: ['Name', 'Port', 'Target', 'Node port'], rows: objs(a['ports']).map(p => ({
          cells: [String(p['name'] ?? ''), `${p['protocol'] ?? 'TCP'}/${p['port']}`, String(p['targetPort'] ?? ''), p['nodePort'] != null ? String(p['nodePort']) : ''] })), empty: 'No ports.' },
        { title: `Selector · ${mapText(a['selector']) || 'none'}`, columns: ['Pod', 'IP', 'Phase'],
          rows: podRows(idx, idx.out(n.id, 'selects').map(e => e.to)), empty: 'Selects no pods (headless or manually managed endpoints).' },
        { title: 'Load balancer', columns: ['Name', 'Scheme', 'DNS'], rows: lbRows(idx, n),
          empty: strs(a['lbHostnames']).length ? `Hostname ${strs(a['lbHostnames']).join(', ')} not matched to a collected load balancer.` : `${str(a['serviceType']) ?? 'ClusterIP'} — no load balancer.` },
      ];
    case 'ingress':
      return [
        { title: 'Rules', columns: ['Host', 'Path', 'Service', 'Port'], rows: objs(a['rules']).map(r => {
          const svc = idx.out(n.id, 'backs').map(e => idx.node(e.to)).find(x => x?.kind === 'k8s-service' && x.name === r['service']);
          return { cells: [String(r['host'] ?? '*'), String(r['path'] ?? '/'), String(r['service'] ?? ''), String(r['port'] ?? '')], nodeId: svc?.id };
        }), empty: 'No rules.' },
        { title: 'Load balancer', columns: ['Name', 'Scheme', 'DNS'], rows: lbRows(idx, n), empty: 'No load balancer matched.' },
      ];
    case 'network-policy':
      return [
        { title: `Selects · ${selectorText(a['podSelector'])} · ${strs(a['policyTypes']).join(' + ')}`, columns: ['Pod', 'IP', 'Phase'],
          rows: podRows(idx, idx.out(n.id, 'selects').map(e => e.to)), empty: 'Selects no pods.' },
        { title: 'Ingress rules', columns: ['#', 'From', 'Ports'], rows: policyRows(n, 'ingress'),
          empty: strs(a['policyTypes']).includes('Ingress') ? 'No ingress rules — all inbound traffic to the selected pods is denied.' : 'Does not govern ingress.' },
        { title: 'Egress rules', columns: ['#', 'To', 'Ports'], rows: policyRows(n, 'egress'),
          empty: strs(a['policyTypes']).includes('Egress') ? 'No egress rules — all outbound traffic from the selected pods is denied.' : 'Does not govern egress.' },
      ];
    case 'pod': {
      const runs = idx.out(n.id, 'runs-on').map(e => idx.node(e.to)).filter((x): x is GraphNode => !!x);
      const pols = idx.in(n.id, 'selects').map(e => idx.node(e.from)).filter((x): x is GraphNode => x?.kind === 'network-policy');
      return [
        { title: 'Containers', columns: ['Name', 'Image'], rows: objs(a['containers']).map(c => ({ cells: [String(c['name'] ?? ''), String(c['image'] ?? '')] })), empty: 'No containers recorded.' },
        { title: 'Placement', columns: ['', ''], rows: [
          { cells: ['Pod IP', strs(a['podIps']).join(', ') || (str(a['podIp']) ?? '—')] },
          { cells: ['Node', [str(a['nodeName']), str(a['instanceId'])].filter(Boolean).join(' · ') || '—'] },
          { cells: ['Owner', [str(a['ownerKind']), str(a['ownerName'])].filter(Boolean).join(' ') || '—'] },
          ...runs.map(r => ({ cells: ['Runs on', `${r.name} (${kindInfo(r.kind).label})`], nodeId: r.id })),
        ] },
        { title: 'Network policies', columns: ['Policy', 'Types'], rows: pols.map(p => ({ cells: [p.name, strs(p.attrs?.['policyTypes']).join(' + ')], nodeId: p.id })),
          empty: 'No NetworkPolicy selects this pod — all traffic is allowed by Kubernetes.' },
      ];
    }
    case 'ecs-service': {
      const tasks = idx.out(n.id, 'runs').map(e => idx.node(e.to)).filter((x): x is GraphNode => !!x);
      const lbs = idx.in(n.id, 'exposes').map(e => ({ e, lb: idx.node(e.from) })).filter(x => x.lb?.kind === 'load-balancer');
      return [
        { title: `Tasks · ${num(a['runningCount']) ?? 0}/${num(a['desiredCount']) ?? 0} running`, columns: ['Task', 'IP', 'Status'],
          rows: tasks.map(t => ({ cells: [t.name, str(t.attrs?.['privateIp']) ?? '', str(t.attrs?.['lastStatus']) ?? ''], nodeId: t.id,
            tone: str(t.attrs?.['publicIp']) ? ('warn' as const) : undefined })), empty: 'No tasks in member networks.' },
        { title: 'Load balancers', columns: ['Load balancer', 'Target group', 'Container port'],
          rows: lbs.map(({ e, lb }) => ({ cells: [lb!.name, str(e.attrs?.['targetGroup']) ?? '', String(num(e.attrs?.['port']) ?? '')], nodeId: lb!.id })),
          empty: 'Not behind a load balancer.' },
        { title: 'Network', columns: ['', ''], rows: [
          { cells: ['Subnets', strs(a['subnets']).join(', ')] }, { cells: ['Security groups', strs(a['securityGroups']).join(', ')] },
          { cells: ['Public IP', str(a['assignPublicIp']) ?? '—'], tone: str(a['assignPublicIp']) === 'ENABLED' ? 'warn' : undefined },
        ] },
      ];
    }
    case 'ecs-task':
      return [
        { title: 'Containers', columns: ['Name', 'Image'], rows: objs(a['containers']).map(c => ({ cells: [String(c['name'] ?? ''), String(c['image'] ?? '')] })), empty: 'No containers recorded.' },
        { title: 'Network', columns: ['', ''], rows: [
          { cells: ['Private IP', str(a['privateIp']) ?? '—'] },
          { cells: ['Public IP', str(a['publicIp']) ?? '—'], tone: str(a['publicIp']) ? 'warn' : undefined },
          ...idx.out(n.id, 'runs-on').map(e => idx.node(e.to)).filter((x): x is GraphNode => !!x).map(r => ({ cells: ['Interface', r.nativeId], nodeId: r.id })),
        ] },
      ];
    case 'lambda-function': {
      const subnets = idx.out(n.id, 'placed-in').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'subnet');
      const sgs = idx.out(n.id, 'uses').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'security-group');
      const enis = idx.out(n.id, 'runs-on').map(e => idx.node(e.to)).filter((x): x is GraphNode => !!x);
      return [
        { title: 'Subnets', columns: ['Subnet', 'CIDR', 'Egress'], rows: subnets.map(s => ({ cells: [s.name, s.cidrs?.join(', ') ?? '', str(s.attrs?.['egress']) ?? ''], nodeId: s.id,
          tone: ['via-nat', 'via-hub', 'via-inspection', 'via-appliance'].includes(str(s.attrs?.['egress']) ?? '') ? undefined : ('warn' as const) })), empty: 'No subnets.' },
        { title: 'Security groups', columns: ['Group', 'Id'], rows: sgs.map(g => ({ cells: [g.name, g.nativeId], nodeId: g.id })), empty: 'No security groups.' },
        { title: 'Interfaces', columns: ['Interface', 'IP'], rows: enis.map(e => ({ cells: [e.nativeId, str(e.attrs?.['privateIp']) ?? ''], nodeId: e.id })),
          empty: 'No Lambda interface collected yet (created on first invocation).' },
      ];
    }
    case 'k8s-cluster':
      return a['readable'] === false
        ? [{ title: 'Not readable', columns: ['Needs'], rows: [{ cells: [str(a['unreadableReason']) ?? 'read access'], tone: 'warn' }] }]
        : null;
    default:
      return null;
  }
}

/** Kind-specific detail tables for the side panel; empty for kinds with nothing extra to show. */
export function nodeDetails(idx: GraphIndex, n: GraphNode): DetailSection[] {
  const w = workloadSections(idx, n);
  if (w) return w;
  switch (n.kind) {
    case 'route-table':
    case 'hub-route-table': {
      const out: DetailSection[] = [{ title: 'Routes', columns: ['Destination', 'Target', 'State', 'Origin'], rows: routeRows(idx, n), empty: 'No routes.' }];
      if (n.kind === 'route-table') out.push({ title: 'Used by subnets', columns: ['Subnet', 'CIDR', 'Association'], rows: usedBy(idx, n), empty: 'No subnets use this table.' });
      return out;
    }
    case 'security-group':
      return [
        { title: 'Inbound rules', columns: ['Traffic', 'Source', 'Description'], rows: sgRows(idx, n, 'ingress'), empty: 'No inbound rules — nothing is allowed in.' },
        { title: 'Outbound rules', columns: ['Traffic', 'Destination', 'Description'], rows: sgRows(idx, n, 'egress'), empty: 'No outbound rules — nothing is allowed out.' },
      ];
    case 'nacl': {
      if (!(n.raw as any)?.Entries) return [{ title: 'Entries', columns: [], rows: [], empty: 'Entries not collected in this snapshot.' }];
      return [
        { title: 'Inbound entries', columns: ['Rule', 'Protocol', 'Ports', 'Source', 'Action'], rows: naclRows(n, false) },
        { title: 'Outbound entries', columns: ['Rule', 'Protocol', 'Ports', 'Destination', 'Action'], rows: naclRows(n, true) },
        { title: 'Used by subnets', columns: ['Subnet', 'CIDR', 'Association'], rows: usedBy(idx, n), empty: 'No subnets associated.' },
      ];
    }
    default:
      return [];
  }
}
