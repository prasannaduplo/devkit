import { KindInfo } from './api-types';

// Mirror of the backend KindRegistry (Core/Graph/Kinds.cs). tests/kinds.test.ts fails if they drift: the
// backend writes tests/fixtures/generated/kinds.json on every test run.
export const KINDS: KindInfo[] = [
  { kind: 'account', level: 1, icon: 'account', label: 'Account', container: true },
  { kind: 'network', level: 1, icon: 'network', label: 'Network', container: true },
  { kind: 'hub', level: 1, icon: 'hub', label: 'Transit hub', container: true },
  { kind: 'peering', level: 1, icon: 'peering', label: 'Peering', container: false },
  { kind: 'external', level: 1, icon: 'external', label: 'External', container: false },
  { kind: 'vpn-connection', level: 2, icon: 'vpn', label: 'Site-to-site VPN', container: true },
  { kind: 'vpn-gateway', level: 2, icon: 'vpn-gateway', label: 'VPN gateway', container: false },
  { kind: 'peer-gateway', level: 2, icon: 'site', label: 'Customer gateway', container: false },
  { kind: 'internet-gateway', level: 2, icon: 'internet-gateway', label: 'Internet gateway', container: false },
  { kind: 'nat-gateway', level: 2, icon: 'nat', label: 'NAT gateway', container: false },
  { kind: 'egress-only-gateway', level: 2, icon: 'egress-only', label: 'Egress-only gateway', container: false },
  { kind: 'firewall-service', level: 2, icon: 'firewall', label: 'Firewall', container: false },
  { kind: 'other-gateway', level: 2, icon: 'gateway', label: 'Gateway', container: false },
  { kind: 'subnet', level: 3, icon: 'subnet', label: 'Subnet', container: true },
  { kind: 'route-table', level: 3, icon: 'route-table', label: 'Route table', container: false },
  { kind: 'hub-route-table', level: 3, icon: 'route-table', label: 'Hub route table', container: false },
  { kind: 'hub-attachment', level: 3, icon: 'attachment', label: 'Hub attachment', container: false },
  { kind: 'load-balancer', level: 3, icon: 'load-balancer', label: 'Load balancer', container: false },
  { kind: 'endpoint', level: 3, icon: 'endpoint', label: 'Endpoint', container: false },
  { kind: 'dns-zone', level: 3, icon: 'dns-zone', label: 'DNS zone', container: false },
  { kind: 'public-ip', level: 3, icon: 'public-ip', label: 'Public IP', container: false },
  { kind: 'resolver-endpoint', level: 3, icon: 'resolver', label: 'Resolver endpoint', container: false },
  { kind: 'resolver-rule', level: 3, icon: 'resolver-rule', label: 'Resolver rule', container: false },
  { kind: 'network-interface', level: 4, icon: 'interface', label: 'Network interface', container: false },
  { kind: 'workload', level: 4, icon: 'workload', label: 'Workload', container: false },
  { kind: 'security-group', level: 4, icon: 'security-group', label: 'Security group', container: false },
  { kind: 'nacl', level: 4, icon: 'nacl', label: 'Network ACL', container: false },
  { kind: 'dns-record', level: 4, icon: 'dns-record', label: 'DNS record', container: false },
  { kind: 'vpn-tunnel', level: 4, icon: 'tunnel', label: 'VPN tunnel', container: false },
  { kind: 'cidr-block', level: 4, icon: 'cidr', label: 'CIDR block', container: false },
  { kind: 'flow-log-config', level: 0, icon: 'flow-logs', label: 'Flow log', container: false },
  { kind: 'dns-query-log-config', level: 0, icon: 'dns-logs', label: 'DNS query log', container: false },
];

const BY_KIND = new Map(KINDS.map(k => [k.kind, k]));

export function kindInfo(kind: string): KindInfo {
  return BY_KIND.get(kind) ?? { kind, level: 3, icon: 'generic', label: kind, container: false };
}
