import { GraphNode, Visibility } from './api-types';
import { ALL_LAYERS, Layers, layerVisible } from './layers';
import { GraphIndex, num, str, strs } from './graph-index';
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

/** A namespace with more pods than this shows them per owner at L4 ("frontend ×14"). */
export const POD_AGGREGATE_THRESHOLD = 12;

/** Which nodes/edges a zoom level (optionally scoped to one container) draws. See Task 4 rules. */
export function computeView(idx: GraphIndex, level: Level, focusId?: string, layers: Layers = ALL_LAYERS): ViewModel {
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
  for (const n of idx.graph.nodes) if (shownKind(n.kind) && inScope(n) && layerVisible(n, layers)) visible.add(n.id);

  // Busy namespaces fold their pods into one box per owner (Deployment / StatefulSet / DaemonSet …) at L4, unless
  // the namespace itself (or one of its pods) is the focus — drilling into the namespace expands them.
  const podToAggregate = new Map<string, string>();
  const podAggregates: ViewNode[] = [];
  if (level === 4) {
    for (const ns of idx.ofKind('k8s-namespace')) {
      if (!visible.has(ns.id) || (focus && (focus.id === ns.id || idx.isAncestor(ns.id, focus.id)))) continue;
      const pods = idx.children(ns.id).filter(c => c.kind === 'pod' && visible.has(c.id));
      if (pods.length <= POD_AGGREGATE_THRESHOLD) continue;
      const groups = new Map<string, GraphNode[]>();
      for (const p of pods) {
        const key = `${str(p.attrs?.['ownerKind']) ?? 'Pod'}/${str(p.attrs?.['ownerName']) ?? p.name}`;
        groups.set(key, [...(groups.get(key) ?? []), p]);
      }
      for (const [key, members] of groups) {
        if (members.length < 2) continue;
        const aggId = `agg:pods:${ns.id}|${key}`;
        const [ownerKind, ownerName] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
        const degraded = members.filter(m => (str(m.attrs?.['phase']) ?? 'Running') !== 'Running').length;
        podAggregates.push({
          id: aggId, kind: 'pod', label: `${ownerName} ×${members.length}`, sublabel: degraded ? `${ownerKind} · ${degraded} not running` : ownerKind,
          parentId: ns.id, container: false, visibility: 'full', aggregate: { count: members.length, degraded, memberIds: members.map(m => m.id) },
        });
        for (const m of members) { visible.delete(m.id); podToAggregate.set(m.id, aggId); }
      }
    }
  }

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
    const from = vpnToAggregate.get(e.from) ?? podToAggregate.get(e.from) ?? endpoint(e.from);
    const to = vpnToAggregate.get(e.to) ?? podToAggregate.get(e.to) ?? endpoint(e.to);
    add(from, to, e.kind, e.id);
  }

  for (const b of boundary.values()) nodes.push({ ...toViewNode(b, undefined), boundary: true });
  nodes.push(...aggregates.values(), ...podAggregates);

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
    case 'k8s-cluster': return a['readable'] === false ? 'not readable' : [str(a['clusterType'])?.toUpperCase(), str(a['version'])].filter(Boolean).join(' ') || undefined;
    case 'k8s-namespace': return typeof a['podCount'] === 'number' ? `${a['podCount']} pod${a['podCount'] === 1 ? '' : 's'}` : undefined;
    case 'pod': return str(a['podIp']) ?? str(a['phase']);
    case 'k8s-service': return [str(a['serviceType']), str(a['scheme'])].filter(Boolean).join(' · ') || undefined;
    case 'ingress': return str(a['ingressClass']) ?? str(a['scheme']);
    case 'network-policy': return strs(a['policyTypes']).join(' + ') || undefined;
    case 'ecs-cluster': return typeof a['taskCount'] === 'number' ? `${a['taskCount']} task${a['taskCount'] === 1 ? '' : 's'}` : undefined;
    case 'ecs-service': return typeof a['runningCount'] === 'number' ? `${a['runningCount']}/${num(a['desiredCount']) ?? '?'} running` : undefined;
    case 'ecs-task': return str(a['privateIp']) ?? str(a['lastStatus']);
    case 'lambda-function': return str(a['runtime']);
    default: return undefined;
  }
}
