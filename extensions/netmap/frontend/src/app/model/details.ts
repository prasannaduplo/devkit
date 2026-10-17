import { GraphEdge, GraphNode } from './api-types';
import { GraphIndex, num, str } from './graph-index';
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

/** Kind-specific detail tables for the side panel; empty for kinds with nothing extra to show. */
export function nodeDetails(idx: GraphIndex, n: GraphNode): DetailSection[] {
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
