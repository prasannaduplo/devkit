import { GraphNode, Visibility } from './api-types';
import { GraphIndex, num, str } from './graph-index';
import { kindInfo } from './kinds';

export type Level = 1 | 2 | 3 | 4;

export interface ViewNode {
  id: string;
  kind: string;
  label: string;
  sublabel?: string;
  parentId?: string;
  container: boolean;
  visibility: Visibility;
  boundary?: boolean;
  source?: GraphNode;
  aggregate?: { count: number; degraded: number; memberIds: string[] };
}

export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  kinds: string[];
  count: number;
  edgeIds: string[];
}

export interface ViewModel {
  level: Level;
  focusId?: string;
  needsFocus: boolean;
  nodes: ViewNode[];
  edges: ViewEdge[];
}

/** Which nodes/edges a zoom level (optionally scoped to one container) draws. See Task 4 rules. */
export function computeView(idx: GraphIndex, level: Level, focusId?: string): ViewModel {
  const focus = focusId ? idx.node(focusId) : undefined;
  if (level === 4 && !(focus && (focus.kind === 'network' || idx.ancestorOfKind(focus.id, 'network')))) {
    return { level, focusId, needsFocus: true, nodes: [], edges: [] };
  }

  const inScope = (n: GraphNode | undefined): boolean => !!n && (!focus || n.id === focus.id || idx.isAncestor(focus.id, n.id));
  const shownKind = (kind: string): boolean => {
    const lv = kindInfo(kind).level;
    return lv >= 1 && lv <= level;
  };

  const visible = new Set<string>();
  for (const n of idx.graph.nodes) if (shownKind(n.kind) && inScope(n)) visible.add(n.id);

  const repCache = new Map<string, string | null>();
  const rep = (id: string): string | null => {
    if (repCache.has(id)) return repCache.get(id)!;
    let r: string | null = null;
    if (visible.has(id)) r = id;
    else for (const a of idx.ancestors(id)) if (visible.has(a.id)) { r = a.id; break; }
    repCache.set(id, r);
    return r;
  };

  const boundary = new Map<string, GraphNode>();
  const outerRep = (id: string): string | null => {
    const n = idx.node(id);
    if (!n) return null;
    const chain = [n, ...idx.ancestors(id)].reverse();
    const top = chain.find(c => kindInfo(c.kind).level === 1 && c.kind !== 'account');
    if (!top) return null;
    if (!visible.has(top.id)) boundary.set(top.id, top);
    return top.id;
  };

  const endpoint = (id: string): string | null => {
    const n = idx.node(id);
    if (!n) return null;
    return focus && !inScope(n) ? outerRep(id) : rep(id);
  };

  // VPN sites collapse below level 2.
  const aggregates = new Map<string, ViewNode>();
  const vpnToAggregate = new Map<string, string>();
  if (level < 2) {
    for (const vpn of idx.ofKind('vpn-connection')) {
      if (!inScope(vpn)) continue;
      const anchorRaw = vpnAnchorOf(idx, vpn);
      const anchor = anchorRaw ? endpoint(anchorRaw) : null;
      if (!anchor) continue;
      const aggId = `agg:vpn-sites:${anchor}`;
      let agg = aggregates.get(aggId);
      if (!agg) {
        agg = { id: aggId, kind: 'external', label: '', container: false, visibility: 'full', aggregate: { count: 0, degraded: 0, memberIds: [] } };
        aggregates.set(aggId, agg);
      }
      agg.aggregate!.count++;
      agg.aggregate!.memberIds.push(vpn.id);
      const up = num(vpn.attrs?.['tunnelsUp']) ?? 0;
      const total = num(vpn.attrs?.['tunnelsTotal']) ?? 0;
      if (total > 0 && up < 2) agg.aggregate!.degraded++;
      vpnToAggregate.set(vpn.id, aggId);
    }
    for (const agg of aggregates.values()) {
      const { count, degraded } = agg.aggregate!;
      agg.label = `${count} VPN site${count === 1 ? '' : 's'}`;
      agg.sublabel = degraded > 0 ? `${degraded} without redundancy` : 'site-to-site';
    }
  }

  const nodes: ViewNode[] = [];
  for (const id of visible) {
    const n = idx.node(id)!;
    const parent = focus && n.id === focus.id ? undefined : idx.ancestors(n.id).find(a => visible.has(a.id))?.id;
    nodes.push(toViewNode(n, parent));
  }
  const edgesByKey = new Map<string, ViewEdge>();
  const add = (from: string | null, to: string | null, kind: string, edgeId: string): void => {
    if (!from || !to || from === to) return;
    if (idx.isAncestor(from, to) || idx.isAncestor(to, from)) return;
    const key = `${from}>${to}`;
    let e = edgesByKey.get(key);
    if (!e) {
      e = { id: `ve:${key}`, from, to, kinds: [], count: 0, edgeIds: [] };
      edgesByKey.set(key, e);
    }
    if (!e.kinds.includes(kind)) e.kinds.push(kind);
    e.count++;
    if (edgeId) e.edgeIds.push(edgeId);
  };

  for (const e of idx.graph.edges) {
    if (focus && !inScope(idx.node(e.from)) && !inScope(idx.node(e.to))) continue;
    const from = vpnToAggregate.get(e.from) ?? endpoint(e.from);
    const to = vpnToAggregate.get(e.to) ?? endpoint(e.to);
    add(from, to, e.kind, e.id);
  }

  for (const b of boundary.values()) nodes.push({ ...toViewNode(b, undefined), boundary: true });
  nodes.push(...aggregates.values());

  return { level, focusId, needsFocus: false, nodes, edges: [...edgesByKey.values()] };
}

/** The node a VPN connection hangs off: its hub (via the hub attachment), its VGW, or its account. */
export function vpnAnchorOf(idx: GraphIndex, vpn: GraphNode): string | undefined {
  for (const e of idx.out(vpn.id, 'attaches')) {
    const target = idx.node(e.to);
    if (!target) return e.to;
    if (target.kind === 'hub-attachment') {
      const hub = idx.out(target.id, 'attaches')[0]?.to;
      if (hub) return hub;
    }
    if (target.kind === 'hub' || target.kind === 'vpn-gateway') return target.id;
  }
  return vpn.parentId;
}

function toViewNode(n: GraphNode, parentId: string | undefined): ViewNode {
  return {
    id: n.id,
    kind: n.kind,
    label: n.name || n.nativeId,
    sublabel: sublabel(n),
    parentId,
    container: kindInfo(n.kind).container,
    visibility: n.visibility,
    source: n,
  };
}

export function sublabel(n: GraphNode): string | undefined {
  const a = n.attrs ?? {};
  const cidrs = n.cidrs ?? [];
  switch (n.kind) {
    case 'network': return cidrs.join(' · ') || undefined;
    case 'subnet': return [cidrs[0], str(a['az'])].filter(Boolean).join(' · ') || undefined;
    case 'hub': return n.visibility === 'full' ? 'transit hub' : n.visibility === 'partial' ? 'route tables not readable' : 'outside blueprint';
    case 'vpn-connection': {
      const total = num(a['tunnelsTotal']);
      return total ? `${num(a['tunnelsUp']) ?? 0}/${total} tunnels up` : undefined;
    }
    case 'nat-gateway': return str(a['connectivityType']);
    case 'public-ip':
    case 'peer-gateway': return str(a['ip']);
    case 'load-balancer': return [str(a['lbType']), str(a['scheme'])].filter(Boolean).join(' · ') || undefined;
    case 'endpoint': return str(a['endpointType']);
    case 'account': return a['inScope'] === false ? 'not in blueprint scopes' : undefined;
    case 'network-interface': return str(a['privateIp']);
    case 'workload': return str(a['workloadType']);
    default: return undefined;
  }
}
