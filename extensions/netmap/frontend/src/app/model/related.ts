import { GraphNode } from './api-types';
import { GraphIndex } from './graph-index';
import { kindInfo } from './kinds';

export interface RelatedItem {
  nodeId: string;
  label: string;
  sub: string;
}

export interface RelatedGroup {
  title: string;
  items: RelatedItem[];
  more: number;
}

const LIMIT = 50;

// How an edge reads from the selected node's side. Edges already shown as detail tables (routes, SG rules) are left out.
const OUT: Record<string, string> = {
  uses: 'Security groups', associated: 'Associated with', attaches: 'Attached', peers: 'Peers with',
  'tunnels-to': 'Tunnels to', 'exits-via': 'Exits via',
};
const IN: Record<string, string> = {
  uses: 'Used by', associated: 'Associated', attaches: 'Attached to', peers: 'Peers with',
  'tunnels-to': 'Tunnels from', 'exits-via': 'Exit for', 'routes-to': 'Route tables pointing here',
};

/** An interface is rarely what the user is looking for — name what owns it (instance, load balancer, NAT…). */
function ownerOf(idx: GraphIndex, eni: GraphNode): GraphNode | undefined {
  const via = idx.in(eni.id, 'attaches').map(e => idx.node(e.from)).find(x => x && x.kind !== 'network');
  return via ?? undefined;
}

function item(idx: GraphIndex, n: GraphNode): RelatedItem {
  const kind = kindInfo(n.kind).label;
  if (n.kind === 'network-interface') {
    const owner = ownerOf(idx, n);
    const ip = typeof n.attrs?.['privateIp'] === 'string' ? (n.attrs['privateIp'] as string) : '';
    if (owner) return { nodeId: owner.id, label: owner.name || owner.nativeId, sub: `${kindInfo(owner.kind).label} · via ${n.nativeId}${ip ? ` · ${ip}` : ''}` };
    return { nodeId: n.id, label: n.name || n.nativeId, sub: [kind, ip].filter(Boolean).join(' · ') };
  }
  const where = n.cidrs?.length ? n.cidrs.join(', ') : '';
  return { nodeId: n.id, label: n.name || n.nativeId, sub: [kind, where].filter(Boolean).join(' · ') };
}

function push(groups: Map<string, Map<string, RelatedItem>>, title: string, it: RelatedItem): void {
  if (!groups.has(title)) groups.set(title, new Map());
  groups.get(title)!.set(it.nodeId, it);
}

/** Everything the selected node is connected to, grouped by relationship, each item navigable. */
export function relatedResources(idx: GraphIndex, n: GraphNode): RelatedGroup[] {
  const groups = new Map<string, Map<string, RelatedItem>>();

  const parent = idx.ancestors(n.id)[0];
  if (parent) push(groups, 'Inside', item(idx, parent));

  for (const c of idx.children(n.id)) push(groups, `Contains · ${kindInfo(c.kind).label}s`, item(idx, c));

  for (const e of idx.out(n.id)) {
    const title = OUT[e.kind];
    const to = idx.node(e.to);
    if (!title || !to || to.kind === 'external' || to.kind === 'cidr-block') continue;
    if (n.kind === 'route-table' || n.kind === 'hub-route-table') if (e.kind === 'routes-to') continue;
    push(groups, title, item(idx, to));
  }
  for (const e of idx.in(n.id)) {
    const title = IN[e.kind];
    const from = idx.node(e.from);
    if (!title || !from || from.kind === 'external' || from.kind === 'cidr-block') continue;
    // a route table's subnets are already in its "Used by subnets" table
    if ((n.kind === 'route-table' || n.kind === 'nacl') && e.kind === 'associated' && from.kind === 'subnet') continue;
    push(groups, title, item(idx, from));
  }

  return [...groups.entries()].map(([title, m]) => {
    const all = [...m.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return { title: `${title} (${all.length})`, items: all.slice(0, LIMIT), more: Math.max(0, all.length - LIMIT) };
  });
}
