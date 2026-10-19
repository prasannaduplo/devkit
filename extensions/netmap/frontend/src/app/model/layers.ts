import { GraphIndex } from './graph-index';
import { GraphNode } from './api-types';

/** Map layers the user can switch on and off. The backbone (accounts, networks, hubs, gateways, load balancers,
 * clusters, the outside world) is always drawn so paths and containers keep their context. */
export interface Layers {
  network: boolean;
  kubernetes: boolean;
  compute: boolean;
}

export type LayerKey = keyof Layers;

export const DEFAULT_LAYERS: Layers = { network: true, kubernetes: false, compute: false };
export const ALL_LAYERS: Layers = { network: true, kubernetes: true, compute: true };

const LAYER_OF: Record<string, LayerKey> = {
  subnet: 'network', 'route-table': 'network', 'hub-route-table': 'network', 'hub-attachment': 'network', nacl: 'network',
  'security-group': 'network', 'network-interface': 'network', endpoint: 'network', 'public-ip': 'network',
  'resolver-endpoint': 'network', 'resolver-rule': 'network', 'dns-zone': 'network', 'dns-record': 'network',
  'cidr-block': 'network', workload: 'network',
  'k8s-namespace': 'kubernetes', 'k8s-service': 'kubernetes', ingress: 'kubernetes', pod: 'kubernetes', 'network-policy': 'kubernetes',
  'ecs-service': 'compute', 'ecs-task': 'compute', 'lambda-function': 'compute',
};

export function layerOf(kind: string): LayerKey | undefined {
  return LAYER_OF[kind];
}

/** Kubernetes and EKS add-on namespaces nobody wants on a network map. Mirrors the backend's K8sSystemNamespaces
 * (newer scans skip them; this hides them in snapshots taken before that). */
export function isSystemNamespace(name: string | undefined | null): boolean {
  if (!name) return false;
  return name === 'kube-system' || name === 'kube-public' || name === 'kube-node-lease' || name.startsWith('amazon-') || name.startsWith('aws-');
}

export function inSystemNamespace(n: GraphNode): boolean {
  if (n.kind === 'k8s-namespace') return isSystemNamespace(n.name);
  const ns = n.attrs?.['namespace'];
  return typeof ns === 'string' && isSystemNamespace(ns);
}

/** Should this node be drawn with these layers? */
export function layerVisible(n: GraphNode, layers: Layers): boolean {
  if (inSystemNamespace(n)) return false;
  const l = layerOf(n.kind);
  return !l || layers[l];
}

/** Layers a node needs switched on to be drawn (used when revealing or tracing to it). */
export function layersFor(idx: GraphIndex, id: string): LayerKey[] {
  const n = idx.node(id);
  const l = n ? layerOf(n.kind) : undefined;
  return l ? [l] : [];
}

/** The graph without Kubernetes system namespaces and everything in them (plus their edges and findings that only
 * concern them). Applied once when a snapshot loads, so map, tables, search, findings and paths all agree. */
export function withoutSystemNamespaces<G extends { nodes: GraphNode[]; edges: { from: string; to: string }[]; findings?: { nodeIds: string[] }[] }>(g: G): G {
  const drop = new Set(g.nodes.filter(inSystemNamespace).map(n => n.id));
  if (!drop.size) return g;
  // descendants of a dropped namespace, whatever their own attrs say
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of g.nodes) if (!drop.has(n.id) && n.parentId && drop.has(n.parentId)) { drop.add(n.id); grew = true; }
  }
  return {
    ...g,
    nodes: g.nodes.filter(n => !drop.has(n.id)),
    edges: g.edges.filter(e => !drop.has(e.from) && !drop.has(e.to)),
    // a finding that only names dropped resources goes; blueprint-wide findings (no resources) stay
    findings: g.findings?.filter(f => !f.nodeIds.length || f.nodeIds.some(id => !drop.has(id))).map(f => ({ ...f, nodeIds: f.nodeIds.filter(id => !drop.has(id)) })),
  };
}
