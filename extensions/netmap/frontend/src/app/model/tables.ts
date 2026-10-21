import { GraphNode } from './api-types';
import { GraphIndex, num, str, strs } from './graph-index';
import { kindInfo } from './kinds';
import { Sev } from './severity';
import { vpnAnchorOf } from './zoom';

export const EGRESS_TEXT: Record<string, string> = {
  direct: 'Direct to internet gateway',
  'via-nat': 'Via NAT gateway',
  'via-private-nat': 'Via private NAT gateway',
  'nat-no-igw': 'NAT gateway without internet route',
  'nat-unavailable': 'NAT gateway unavailable',
  'via-hub': 'Via transit hub',
  'via-hub-partial': 'Via transit hub (route tables not readable)',
  'via-inspection': 'Via inspection endpoint',
  'via-peering': 'Via peering',
  'via-appliance': 'Via appliance',
  'via-vpn': 'Via VPN gateway',
  blackhole: 'Blackhole route',
  unknown: 'Unknown target',
  isolated: 'No default route',
};

const EGRESS_SEV: Record<string, Sev> = {
  blackhole: 'bad', 'nat-no-igw': 'warn', 'nat-unavailable': 'warn', 'via-hub-partial': 'warn', unknown: 'warn',
};

const nativeOf = (id: string): string => id.split(':').slice(4).join(':') || id;
const nameOf = (idx: GraphIndex, id: string | undefined): string => (id ? idx.node(id)?.name ?? nativeOf(id) : '');
const byText = <T>(key: (r: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

export interface EgressRow {
  id: string; network: string; subnet: string; cidr: string; az: string;
  egress: string; egressText: string; target: string; publicIps: string; severity: Sev;
}

export function egressRows(idx: GraphIndex): EgressRow[] {
  return idx.ofKind('subnet')
    .filter(s => s.visibility === 'full' && s.membership === 'blueprint')
    .map(s => {
      const cls = str(s.attrs?.['egress']) ?? 'unknown';
      const targetId = str(s.attrs?.['egressTarget']);
      const target = targetId ? idx.node(targetId) : undefined;
      const ips = target?.kind === 'nat-gateway'
        ? idx.out(target.id, 'exits-via').map(e => str(idx.node(e.to)?.attrs?.['ip'])).filter((x): x is string => !!x)
        : [];
      return {
        id: s.id,
        network: idx.ancestorOfKind(s.id, 'network')?.name ?? '',
        subnet: s.name,
        cidr: s.cidrs?.[0] ?? '',
        az: str(s.attrs?.['az']) ?? '',
        egress: cls,
        egressText: EGRESS_TEXT[cls] ?? cls,
        target: targetId ? nameOf(idx, targetId) : '—',
        publicIps: ips.join(', '),
        severity: EGRESS_SEV[cls] ?? 'ok',
      };
    })
    .sort((a, b) => a.network.localeCompare(b.network) || a.subnet.localeCompare(b.subnet));
}

export interface VpnRow {
  id: string; name: string; state: string; routing: string; tunnels: string; tunnelDetail: string;
  customerGateway: string; cgwIp: string; bgpAsn: string; attachedTo: string; staticRoutes: string; severity: Sev;
}

export function vpnRows(idx: GraphIndex): VpnRow[] {
  return idx.ofKind('vpn-connection').map(v => {
    const a = v.attrs ?? {};
    const up = num(a['tunnelsUp']) ?? 0;
    const total = num(a['tunnelsTotal']) ?? 0;
    const tunnels = idx.children(v.id).filter(c => c.kind === 'vpn-tunnel');
    const cgw = idx.node(idx.out(v.id, 'tunnels-to')[0]?.to ?? '');
    return {
      id: v.id,
      name: v.name,
      state: v.state ?? '',
      routing: str(a['routing']) ?? '',
      tunnels: total ? `${up}/${total} up` : '—',
      tunnelDetail: tunnels.map(t => {
        const msg = str(t.attrs?.['statusMessage']);
        return `${str(t.attrs?.['outsideIp']) ?? t.name} ${str(t.attrs?.['status']) ?? ''}${msg ? ` (${msg})` : ''}`.trim();
      }).join(' · '),
      customerGateway: cgw?.name ?? '',
      cgwIp: str(cgw?.attrs?.['ip']) ?? '',
      bgpAsn: str(cgw?.attrs?.['bgpAsn']) ?? '',
      attachedTo: nameOf(idx, vpnAnchorOf(idx, v)),
      staticRoutes: strs(a['staticRoutes']).join(', '),
      severity: (total > 0 && up < 2 ? 'warn' : 'ok') as Sev,
    };
  }).sort(byText(r => r.name));
}

export interface HubRow {
  id: string; name: string; owner: string; visibility: string; attachments: string;
  routeTables: number; blackholes: number; truncated: boolean; severity: Sev;
}

export function hubRows(idx: GraphIndex): HubRow[] {
  return idx.ofKind('hub').map(h => {
    const kids = idx.children(h.id);
    const byType = new Map<string, number>();
    for (const att of kids.filter(k => k.kind === 'hub-attachment')) {
      const t = str(att.attrs?.['resourceType']) ?? 'other';
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    const rts = kids.filter(k => k.kind === 'hub-route-table');
    const blackholes = rts.reduce((n, rt) => n + strs(rt.attrs?.['blackholeRoutes']).length, 0);
    const severity: Sev = blackholes > 0 ? 'bad' : h.visibility === 'partial' ? 'warn' : h.visibility === 'stub' ? 'stub' : 'ok';
    return {
      id: h.id,
      name: h.name,
      owner: h.ownerAccount ?? h.account ?? '',
      visibility: h.visibility,
      attachments: [...byType.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([t, c]) => `${t} ${c}`).join(' · ') || '—',
      routeTables: rts.length,
      blackholes,
      truncated: rts.some(rt => rt.attrs?.['routesTruncated'] === true),
      severity,
    };
  }).sort(byText(r => r.name));
}

export interface PeeringRow { id: string; name: string; status: string; requester: string; accepter: string }

export function peeringRows(idx: GraphIndex): PeeringRow[] {
  const side = (a: Record<string, unknown>, p: 'requester' | 'accepter') =>
    [str(a[`${p}Vpc`]), str(a[`${p}Account`]), str(a[`${p}Region`]), str(a[`${p}Cidr`])].filter(Boolean).join(' · ');
  return idx.ofKind('peering').map(p => ({
    id: p.id,
    name: p.name,
    status: p.state ?? p.nativeState ?? '',
    requester: side(p.attrs ?? {}, 'requester'),
    accepter: side(p.attrs ?? {}, 'accepter'),
  })).sort(byText(r => r.name));
}

export interface DnsData {
  zones: { id: string; name: string; private: string; records: number; networks: string }[];
  rules: { id: string; name: string; domain: string; targets: string; networks: string }[];
  endpoints: { id: string; name: string; direction: string; network: string }[];
}

export function dnsData(idx: GraphIndex): DnsData {
  const networksOf = (n: GraphNode) =>
    idx.in(n.id, 'associated').map(e => idx.node(e.from)).filter(x => x?.kind === 'network').map(x => x!.name).join(', ');
  return {
    zones: idx.ofKind('dns-zone').map(z => ({
      id: z.id, name: z.name,
      private: z.attrs?.['private'] === true ? 'private' : 'public',
      records: idx.children(z.id).filter(c => c.kind === 'dns-record').length,
      networks: networksOf(z),
    })).sort(byText(r => r.name)),
    rules: idx.ofKind('resolver-rule').map(r => ({
      id: r.id, name: r.name, domain: str(r.attrs?.['domain']) ?? '', targets: strs(r.attrs?.['targetIps']).join(', '), networks: networksOf(r),
    })).sort(byText(r => r.name)),
    endpoints: idx.ofKind('resolver-endpoint').map(e => ({
      id: e.id, name: e.name, direction: str(e.attrs?.['direction']) ?? '', network: idx.ancestorOfKind(e.id, 'network')?.name ?? '',
    })).sort(byText(r => r.name)),
  };
}

export interface FlowLogRow { id: string; network: string; coverage: 'network' | 'all subnets' | 'some subnets' | 'none'; destinations: string; severity: Sev }

export function flowLogRows(idx: GraphIndex): FlowLogRow[] {
  const configsOf = (id: string) => idx.out(id, 'associated').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'flow-log-config');
  return idx.ofKind('network').filter(n => n.visibility === 'full' && n.membership === 'blueprint').map(net => {
    const own = configsOf(net.id);
    const subnets = idx.children(net.id).filter(c => c.kind === 'subnet');
    const covered = subnets.filter(s => configsOf(s.id).length > 0);
    const all = [...own, ...subnets.flatMap(s => configsOf(s.id))];
    const coverage: FlowLogRow['coverage'] = own.length > 0 ? 'network'
      : subnets.length > 0 && covered.length === subnets.length ? 'all subnets'
      : covered.length > 0 ? 'some subnets' : 'none';
    const destinations = [...new Set(all.map(c => `${str(c.attrs?.['destinationType']) ?? '?'}: ${str(c.attrs?.['destination']) ?? '?'}`))].join(' · ');
    return { id: net.id, network: net.name, coverage, destinations: destinations || '—', severity: (coverage === 'network' || coverage === 'all subnets' ? 'ok' : 'warn') as Sev };
  }).sort(byText(r => r.network));
}

export interface FindingRow { id: string; ruleId: string; severity: string; message: string; resources: string; /** First resource that is in the graph — the map reveals it. */ nodeId: string }

export function findingRows(idx: GraphIndex): FindingRow[] {
  const rank: Record<string, number> = { bad: 0, warn: 1, ok: 2 };
  return (idx.graph.findings ?? []).map((f, i) => ({
    id: `${f.ruleId}-${i}`,
    ruleId: f.ruleId,
    severity: f.severity,
    message: f.message,
    resources: f.nodeIds.map(id => nameOf(idx, id)).join(', '),
    nodeId: f.nodeIds.find(id => !!idx.node(id)) ?? f.nodeIds[0] ?? '',
  })).sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || a.ruleId.localeCompare(b.ruleId));
}

export interface InventoryRow {
  id: string; kind: string; kindLabel: string; name: string; nativeId: string; account: string; region: string;
  network: string; visibility: string; membership: string; state: string; tags: string; seenFrom: string;
}

export function inventoryRows(idx: GraphIndex): InventoryRow[] {
  return idx.graph.nodes.map(n => ({
    id: n.id,
    kind: n.kind,
    kindLabel: kindInfo(n.kind).label,
    name: n.name,
    nativeId: n.nativeId,
    account: n.ownerAccount ?? n.account ?? '',
    region: n.region ?? '',
    network: n.kind === 'network' ? n.name : idx.ancestorOfKind(n.id, 'network')?.name ?? '',
    visibility: n.visibility,
    membership: n.membership,
    state: n.state ?? '',
    tags: Object.entries(n.tags ?? {}).map(([k, v]) => `${k}=${v}`).join('; '),
    seenFrom: (n.seenFrom ?? []).join(', '),
  })).sort((a, b) => a.kindLabel.localeCompare(b.kindLabel) || a.name.localeCompare(b.name));
}

export interface InventoryFilter { text?: string; kind?: string; visibility?: string; network?: string }

export function filterInventory(rows: InventoryRow[], f: InventoryFilter): InventoryRow[] {
  const text = f.text?.trim().toLowerCase();
  return rows.filter(r =>
    (!f.kind || r.kind === f.kind) &&
    (!f.visibility || r.visibility === f.visibility) &&
    (!f.network || r.network === f.network) &&
    (!text || [r.name, r.nativeId, r.kindLabel, r.tags, r.network].some(v => v.toLowerCase().includes(text))));
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\n') + '\n';
}

// ---- workloads (v2b) -------------------------------------------------------------------------------------------

export interface ClusterRow { id: string; name: string; type: string; network: string; version: string; access: string; namespaces: number; pods: number; services: number; detail: string; severity: Sev }
export interface NamespaceRow { id: string; cluster: string; name: string; pods: number; services: number; ingresses: number; policies: number; severity: Sev }
export interface K8sServiceRow { id: string; cluster: string; namespace: string; name: string; type: string; scheme: string; ports: string; pods: number; loadBalancer: string; severity: Sev }
export interface EcsServiceRow { id: string; cluster: string; name: string; running: string; launchType: string; loadBalancer: string; publicIps: string; network: string; severity: Sev }
export interface LambdaRow { id: string; name: string; network: string; runtime: string; subnets: string; egress: string; interfaces: number; severity: Sev }

export interface WorkloadsData {
  clusters: ClusterRow[]; namespaces: NamespaceRow[]; services: K8sServiceRow[]; ecsServices: EcsServiceRow[]; lambdas: LambdaRow[];
}

const LAMBDA_INTERNET = new Set(['via-nat', 'via-hub', 'via-inspection', 'via-appliance', 'via-private-nat', 'via-vpn', 'via-peering', 'via-hub-partial']);

export function workloadsData(idx: GraphIndex): WorkloadsData {
  const kids = (id: string, kind: string) => idx.children(id).filter(c => c.kind === kind);
  const netName = (n: GraphNode) => idx.ancestorOfKind(n.id, 'network')?.name ?? '';
  const lbNames = (n: GraphNode) => idx.out(n.id, 'backs').map(e => idx.node(e.to)).filter(x => x?.kind === 'load-balancer').map(x => x!.name).join(', ');

  const namespaces: NamespaceRow[] = idx.ofKind('k8s-namespace').map(ns => {
    const pods = kids(ns.id, 'pod').length;
    const policies = kids(ns.id, 'network-policy').length;
    return {
      id: ns.id, cluster: str(ns.attrs?.['cluster']) ?? idx.node(ns.parentId ?? '')?.name ?? '', name: ns.name, pods,
      services: kids(ns.id, 'k8s-service').length, ingresses: kids(ns.id, 'ingress').length, policies,
      severity: (pods > 0 && policies === 0 ? 'warn' : 'ok') as Sev,
    };
  }).sort((a, b) => a.cluster.localeCompare(b.cluster) || a.name.localeCompare(b.name));

  const clusters: ClusterRow[] = idx.ofKind('k8s-cluster').map(c => {
    const nss = kids(c.id, 'k8s-namespace');
    const readable = c.attrs?.['readable'] !== false;
    return {
      id: c.id, name: c.name, type: (str(c.attrs?.['clusterType']) ?? 'k8s').toUpperCase(), network: netName(c), version: str(c.attrs?.['version']) ?? '',
      access: readable ? 'readable' : 'not-readable', namespaces: nss.length,
      pods: nss.reduce((n, ns) => n + kids(ns.id, 'pod').length, 0), services: nss.reduce((n, ns) => n + kids(ns.id, 'k8s-service').length, 0),
      detail: readable ? (c.attrs?.['podsTruncated'] === true ? 'pods truncated at 3000' : '') : `needs ${str(c.attrs?.['unreadableReason']) ?? 'read access'}`,
      severity: (readable ? 'ok' : 'warn') as Sev,
    };
  }).sort(byText(r => r.name));

  const services: K8sServiceRow[] = idx.ofKind('k8s-service').map(s => {
    const a = s.attrs ?? {};
    const ports = (Array.isArray(a['ports']) ? (a['ports'] as { port?: number; protocol?: string }[]) : []).map(p => `${p.protocol ?? 'TCP'}/${p.port ?? '?'}`).join(', ');
    const scheme = str(a['scheme']) ?? '';
    return {
      id: s.id, cluster: str(a['cluster']) ?? '', namespace: str(a['namespace']) ?? '', name: s.name, type: str(a['serviceType']) ?? '', scheme, ports,
      pods: idx.out(s.id, 'selects').length, loadBalancer: lbNames(s) || strs(a['lbHostnames']).join(', '),
      severity: (scheme === 'internet-facing' ? 'warn' : 'ok') as Sev,
    };
  }).sort((a, b) => a.cluster.localeCompare(b.cluster) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));

  const ecsServices: EcsServiceRow[] = idx.ofKind('ecs-service').map(s => {
    const tasks = idx.out(s.id, 'runs').map(e => idx.node(e.to)).filter((x): x is GraphNode => !!x);
    const pubs = tasks.map(t => str(t.attrs?.['publicIp'])).filter((x): x is string => !!x);
    return {
      id: s.id, cluster: str(s.attrs?.['cluster']) ?? '', name: s.name,
      running: `${num(s.attrs?.['runningCount']) ?? tasks.length}/${num(s.attrs?.['desiredCount']) ?? '?'}`,
      launchType: str(s.attrs?.['launchType']) ?? '',
      loadBalancer: idx.in(s.id, 'exposes').map(e => idx.node(e.from)?.name).filter(Boolean).join(', '),
      publicIps: pubs.join(', '), network: netName(s), severity: (pubs.length ? 'warn' : 'ok') as Sev,
    };
  }).sort((a, b) => a.cluster.localeCompare(b.cluster) || a.name.localeCompare(b.name));

  const lambdas: LambdaRow[] = idx.ofKind('lambda-function').map(f => {
    const subnets = idx.out(f.id, 'placed-in').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'subnet');
    const classes = subnets.map(s => str(s.attrs?.['egress']) ?? 'unknown');
    return {
      id: f.id, name: f.name, network: netName(f), runtime: str(f.attrs?.['runtime']) ?? '', subnets: subnets.map(s => s.name).join(', '),
      egress: [...new Set(classes.map(c => EGRESS_TEXT[c] ?? c))].join(' · '),
      interfaces: idx.out(f.id, 'runs-on').length,
      severity: (classes.some(c => !LAMBDA_INTERNET.has(c)) ? 'warn' : 'ok') as Sev,
    };
  }).sort(byText(r => r.name));

  return { clusters, namespaces, services, ecsServices, lambdas };
}
