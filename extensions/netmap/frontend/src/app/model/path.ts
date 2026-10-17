import { GraphEdge, GraphNode, Json } from './api-types';
import { parseV4 } from './cidr';
import { GraphIndex, num, str, strs } from './graph-index';

// Static reachability over one snapshot graph: "can this resource reach X" (outbound) and "who can reach this
// resource" (inbound). Evaluates security groups, network ACLs (raw entries) and route tables hop by hop.
// Framework-free: no @angular imports in model/.
//
// What it does NOT model: return traffic for stateless NACLs (ephemeral ports), the peer side's route back over a
// VPC peering, TGW attachment subnets (not collected — the path follows the network's onward route table and says
// so), appliances / ENI route targets, IPv6, prefix lists that were not resolved, and DNS.

export type Verdict = 'allow' | 'block' | 'unknown' | 'info';
export type Outcome = 'reaches' | 'blocked' | 'unknown' | 'leaves-blueprint';
export type Protocol = 'tcp' | 'udp' | 'icmp' | 'all';
export type PathTarget = { kind: 'internet' } | { kind: 'ip'; ip: string } | { kind: 'node'; id: string };

export interface PathQuery {
  from: string;
  to?: PathTarget;
  protocol?: Protocol;
  port?: number;
  direction: 'outbound' | 'inbound';
}

export interface Hop {
  nodeId: string;
  edgeId?: string;
  verdict: Verdict;
  title: string;
  reason: string;
  /** The exact route / SG rule / NACL entry text that decided this hop. */
  rule?: string;
}

export interface OutsideRef { nodeId: string; account?: string; region?: string; networkNativeId?: string }

export interface PathResult {
  outcome: Outcome;
  hops: Hop[];
  outside?: OutsideRef;
  /** One line for the banner. */
  summary: string;
  /** Some check on the way could not be evaluated (missing NACL/SG data) — the outcome is the best reading. */
  uncertain?: boolean;
  /** Inbound: the entry point this result starts from. */
  label?: string;
}

export const INTERNET_ID = 'net:-:global:external:internet';

type Range = [number, number];
const ALL: Range = [0, 4294967295];
const PRIVATE: Range[] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16']
  .map(c => parseV4(c)!);

interface Traffic { proto: Protocol; port: number }

interface Dest {
  range: Range;
  label: string;
  /** Not a private address: routable on the internet. */
  isPublic: boolean;
  nodeId?: string;
  eni?: GraphNode;
}

// ---------------------------------------------------------------------------------------------------------------
// small helpers

function ipNum(ip: string): number | null {
  const r = parseV4(`${ip.trim()}/32`);
  return r ? r[0] : null;
}

function cidrRange(c: string | undefined): Range | null {
  return c ? parseV4(c) : null;
}

function contains(outer: Range, inner: Range): boolean {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

function prefixLen(r: Range): number {
  return 32 - Math.round(Math.log2(r[1] - r[0] + 1));
}

function rangeText(r: Range | null): string {
  if (!r) return 'unknown source';
  if (r[0] === ALL[0] && r[1] === ALL[1]) return '0.0.0.0/0';
  const ip = [r[0] >>> 24, (r[0] >>> 16) & 255, (r[0] >>> 8) & 255, r[0] & 255].join('.');
  return `${ip}/${prefixLen(r)}`;
}

function destText(d: Dest): string {
  return d.range[0] === ALL[0] && d.range[1] === ALL[1] ? 'the internet (0.0.0.0/0)' : rangeText(d.range);
}

function isPublicRange(r: Range): boolean {
  return !PRIVATE.some(p => contains(p, r));
}

const nameOf = (n: GraphNode | undefined, fallback = ''): string => (n ? n.name || n.nativeId : fallback);

function trafficText(t: Traffic): string {
  if (t.proto === 'all') return 'all traffic';
  if (t.proto === 'icmp') return 'icmp';
  return `${t.proto}/${t.port}`;
}

function portsText(proto: string, from: number | undefined, to: number | undefined): string {
  if (proto === 'all' || proto === 'icmp') return '';
  if (from === undefined || from === -1 || (from === 0 && to === 65535)) return ' all ports';
  return from === to || to === undefined ? ` ${from}` : ` ${from}-${to}`;
}

function normProto(p: unknown): string {
  const s = String(p ?? '').toLowerCase();
  if (s === '-1' || s === 'all' || s === '') return 'all';
  if (s === '6') return 'tcp';
  if (s === '17') return 'udp';
  if (s === '1') return 'icmp';
  return s;
}

/** Does a rule for protocol/ports cover the traffic entirely? */
function ruleCovers(proto: string, from: number | undefined, to: number | undefined, t: Traffic): boolean {
  if (proto === 'all') return true;
  if (t.proto === 'all' || proto !== t.proto) return false;
  if (proto === 'icmp') return true;
  if (from === undefined || from === -1) return true;
  return t.port >= from && t.port <= (to ?? from);
}

function isUsable(n: GraphNode | undefined): boolean {
  return !!n && n.visibility !== 'stub' && n.membership === 'blueprint';
}

function accountOf(idx: GraphIndex, n: GraphNode): string | undefined {
  return n.ownerAccount ?? n.account ?? idx.ancestorOfKind(n.id, 'account')?.nativeId;
}

function regionOfId(id: string): string | undefined {
  const r = id.split(':')[2];
  return r && r !== '-' ? r : undefined;
}

function outsideRef(idx: GraphIndex, id: string): OutsideRef {
  const n = idx.node(id);
  if (!n) return { nodeId: id, region: regionOfId(id) };
  return { nodeId: id, account: accountOf(idx, n), region: n.region ?? regionOfId(id), networkNativeId: n.kind === 'network' ? n.nativeId : undefined };
}

// ---------------------------------------------------------------------------------------------------------------
// graph lookups

/** The interfaces a resource sends from: itself, or what it attaches (workload/LB/endpoint → ENIs). */
export function interfacesOf(idx: GraphIndex, n: GraphNode): GraphNode[] {
  if (n.kind === 'network-interface') return [n];
  return idx.out(n.id, 'attaches').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'network-interface');
}

function ipsOf(eni: GraphNode): string[] {
  const ips = [str(eni.attrs?.['privateIp']), ...strs(eni.attrs?.['privateIps'])].filter((x): x is string => !!x);
  return [...new Set(ips)];
}

function publicIpOf(idx: GraphIndex, eni: GraphNode): string | undefined {
  const direct = str(eni.attrs?.['publicIp']);
  if (direct) return direct;
  for (const e of idx.out(eni.id, 'associated')) {
    const p = idx.node(e.to);
    if (p?.kind === 'public-ip') return str(p.attrs?.['ip']);
  }
  return undefined;
}

function sgsOf(idx: GraphIndex, n: GraphNode): GraphNode[] {
  return idx.out(n.id, 'uses').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'security-group');
}

function subnetOf(idx: GraphIndex, n: GraphNode): GraphNode | undefined {
  if (n.kind === 'subnet') return n;
  const anc = idx.ancestorOfKind(n.id, 'subnet');
  if (anc) return anc;
  const placed = idx.out(n.id, 'placed-in').map(e => idx.node(e.to)).find(x => x?.kind === 'subnet');
  return placed;
}

function networkOf(idx: GraphIndex, n: GraphNode): GraphNode | undefined {
  return n.kind === 'network' ? n : idx.ancestorOfKind(n.id, 'network');
}

function routeTableOf(idx: GraphIndex, subnet: GraphNode): GraphNode | undefined {
  return idx.out(subnet.id, 'associated').map(e => idx.node(e.to)).find(x => x?.kind === 'route-table');
}

function naclOf(idx: GraphIndex, subnet: GraphNode): GraphNode | undefined {
  return idx.out(subnet.id, 'associated').map(e => idx.node(e.to)).find(x => x?.kind === 'nacl');
}

function mainRouteTable(idx: GraphIndex, network: GraphNode): GraphNode | undefined {
  const rts = idx.children(network.id).filter(c => c.kind === 'route-table');
  return rts.find(r => r.attrs?.['main'] === true) ?? rts[0];
}

function smallestSubnetContaining(idx: GraphIndex, network: GraphNode | undefined, r: Range): GraphNode | undefined {
  const pool = network ? idx.children(network.id) : idx.graph.nodes;
  let best: GraphNode | undefined;
  let bestLen = -1;
  for (const s of pool) {
    if (s.kind !== 'subnet') continue;
    for (const c of s.cidrs ?? []) {
      const sr = cidrRange(c);
      if (sr && contains(sr, r) && prefixLen(sr) > bestLen) { best = s; bestLen = prefixLen(sr); }
    }
  }
  return best;
}

function networkContains(n: GraphNode, r: Range): boolean {
  return (n.cidrs ?? []).some(c => { const x = cidrRange(c); return !!x && contains(x, r); });
}

function eniByIp(idx: GraphIndex, ip: string): GraphNode | undefined {
  return idx.ofKind('network-interface').find(e => ipsOf(e).includes(ip));
}

// ---------------------------------------------------------------------------------------------------------------
// route lookup

interface RouteChoice { dest: string; target: string; state: string; edge?: GraphEdge; blackhole: boolean; len: number }

/** Longest-prefix match over a VPC route table (+ the implicit local route) or a hub route table. */
function lookupRoute(idx: GraphIndex, rt: GraphNode, dest: Range, localCidrs: string[]): RouteChoice | undefined {
  const candidates: RouteChoice[] = [];
  for (const c of localCidrs) {
    const r = cidrRange(c);
    if (r && contains(r, dest)) candidates.push({ dest: c, target: 'local', state: 'active', blackhole: false, len: prefixLen(r) + 0.5 });
  }
  for (const e of idx.out(rt.id, 'routes-to')) {
    const d = str(e.attrs?.['destination']) ?? '';
    const cidrs = d.startsWith('pl-') ? strs(e.attrs?.['prefixListCidrs']) : [d];
    const state = str(e.attrs?.['state']) ?? 'active';
    for (const c of cidrs) {
      const r = cidrRange(c);
      if (!r || !contains(r, dest)) continue;
      candidates.push({ dest: d === c ? c : `${d} (${c})`, target: e.to, state, edge: e, blackhole: state === 'blackhole', len: prefixLen(r) });
    }
  }
  for (const b of strs(rt.attrs?.['blackholeRoutes'])) {
    const r = cidrRange(b);
    if (r && contains(r, dest)) candidates.push({ dest: b, target: '', state: 'blackhole', blackhole: true, len: prefixLen(r) });
  }
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0];
}

function routeText(idx: GraphIndex, c: RouteChoice): string {
  if (c.target === 'local') return `${c.dest} → local`;
  if (!c.target) return `${c.dest} → blackhole`;
  const t = idx.node(c.target);
  return `${c.dest} → ${t ? `${t.nativeId}${t.name && t.name !== t.nativeId ? ` (${t.name})` : ''}` : c.target.split(':').slice(4).join(':')}${c.state !== 'active' ? ` [${c.state}]` : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------
// security groups and NACLs

interface Check { verdict: Verdict; nodeId: string; edgeId?: string; reason: string; rule?: string }

function sgRulesKnown(idx: GraphIndex, sg: GraphNode, dir: 'egress' | 'ingress'): boolean {
  const key = dir === 'egress' ? 'IpPermissionsEgress' : 'IpPermissions';
  if (sg.raw && Array.isArray(sg.raw[key])) return true;
  return idx.out(sg.id, 'allows').length > 0 || idx.in(sg.id, 'allows').length > 0;
}

function sgRuleText(idx: GraphIndex, e: GraphEdge, dir: 'egress' | 'ingress'): string {
  const proto = normProto(e.attrs?.['protocol']);
  const peerId = dir === 'egress' ? e.to : e.from;
  const peer = idx.node(peerId);
  const peerText = peerId === INTERNET_ID ? '0.0.0.0/0' : peer?.kind === 'cidr-block' ? peer.cidrs?.[0] ?? peer.nativeId : peer ? `${peer.nativeId}${peer.name && peer.name !== peer.nativeId ? ` (${peer.name})` : ''}` : peerId;
  const desc = str(e.attrs?.['description']);
  return `${dir} ${proto}${portsText(proto, num(e.attrs?.['fromPort']), num(e.attrs?.['toPort']))} ${dir === 'egress' ? '→' : '←'} ${peerText}${desc ? ` "${desc}"` : ''}`;
}

/**
 * Do any of these security groups allow the traffic? `peer` is the other end: its address range (null when not
 * known) and the security groups it uses (SG-to-SG rules).
 */
function evalSgs(idx: GraphIndex, sgs: GraphNode[], dir: 'egress' | 'ingress', peerRange: Range | null, peerSgs: string[], t: Traffic, anchor: string): Check {
  if (!sgs.length) return { verdict: 'unknown', nodeId: anchor, reason: 'No security groups collected for this interface.' };
  const known = sgs.filter(sg => sgRulesKnown(idx, sg, dir));
  if (!known.length) return { verdict: 'unknown', nodeId: sgs[0].id, reason: `Rules of ${sgs.map(s => s.nativeId).join(', ')} were not collected.` };
  let maybe: { sg: GraphNode; e: GraphEdge; why: string } | undefined;
  for (const sg of known) {
    const edges = dir === 'egress' ? idx.out(sg.id, 'allows') : idx.in(sg.id, 'allows');
    for (const e of edges) {
      if ((str(e.attrs?.['direction']) ?? (dir === 'egress' ? 'egress' : 'ingress')) !== dir) continue;
      if (!ruleCovers(normProto(e.attrs?.['protocol']), num(e.attrs?.['fromPort']), num(e.attrs?.['toPort']), t)) continue;
      const peerId = dir === 'egress' ? e.to : e.from;
      const peer = idx.node(peerId);
      let match: boolean | null = false;
      if (peerId === INTERNET_ID) match = true;
      else if (peer?.kind === 'cidr-block') {
        const r = cidrRange(peer.cidrs?.[0] ?? peer.nativeId);
        match = !r ? null : peerRange ? contains(r, peerRange) : null;
      } else if (peer?.kind === 'security-group') match = peerSgs.includes(peerId) ? true : peerRange ? false : null;
      if (match === true) {
        return { verdict: 'allow', nodeId: sg.id, edgeId: e.id, reason: `${sg.nativeId}${sg.name !== sg.nativeId ? ` (${sg.name})` : ''} allows ${trafficText(t)} ${dir === 'egress' ? 'to' : 'from'} ${rangeText(peerRange ?? (peerId === INTERNET_ID ? ALL : null))}.`, rule: sgRuleText(idx, e, dir) };
      }
      if (match === null && !maybe) maybe = { sg, e, why: peer?.attrs?.['unresolved'] === true ? 'the rule uses a prefix list that was not resolved' : 'the other end’s address is not known' };
    }
  }
  if (maybe) return { verdict: 'unknown', nodeId: maybe.sg.id, edgeId: maybe.e.id, reason: `A rule may allow it, but ${maybe.why}.`, rule: sgRuleText(idx, maybe.e, dir) };
  return {
    verdict: 'block', nodeId: known[0].id,
    reason: `No ${dir} rule in ${known.map(s => s.nativeId).join(', ')} allows ${trafficText(t)} ${dir === 'egress' ? 'to' : 'from'} ${rangeText(peerRange)}.`,
  };
}

interface NaclEntry { RuleNumber?: number; Egress?: boolean; RuleAction?: string; Protocol?: string; CidrBlock?: string; PortRange?: { From?: number; To?: number } }

function naclEntryText(e: NaclEntry): string {
  const proto = normProto(e.Protocol);
  const n = e.RuleNumber === 32767 ? '*' : String(e.RuleNumber ?? '?');
  return `#${n} ${e.RuleAction ?? '?'} ${proto}${portsText(proto, e.PortRange?.From, e.PortRange?.To)} ${e.Egress ? '→' : '←'} ${e.CidrBlock ?? '?'}`;
}

/** Network ACL of a subnet, evaluated in rule-number order. `peer` = the far end (dest for egress, source for ingress). */
function evalNacl(idx: GraphIndex, subnet: GraphNode, egress: boolean, peer: Range | null, t: Traffic): Check {
  const nacl = naclOf(idx, subnet);
  if (!nacl) return { verdict: 'unknown', nodeId: subnet.id, reason: 'No network ACL collected for this subnet — not evaluated.' };
  const raw = nacl.raw?.['Entries'] as Json;
  if (!Array.isArray(raw)) return { verdict: 'unknown', nodeId: nacl.id, reason: 'The network ACL’s entries were not collected.' };
  const entries = (raw as unknown as NaclEntry[])
    .filter(e => !!e && e.Egress === egress && typeof e.CidrBlock === 'string')
    .sort((a, b) => (a.RuleNumber ?? 0) - (b.RuleNumber ?? 0));
  for (const e of entries) {
    const proto = normProto(e.Protocol);
    const r = cidrRange(e.CidrBlock);
    if (!r) continue;
    const covers = ruleCovers(proto, e.PortRange?.From, e.PortRange?.To, t);
    if (!covers) continue;
    const isAll = r[0] === ALL[0] && r[1] === ALL[1];
    if (!peer && !isAll) {
      return { verdict: 'unknown', nodeId: nacl.id, reason: `Entry ${naclEntryText(e)} may decide, but the ${egress ? 'destination' : 'source'} address is not known.`, rule: naclEntryText(e) };
    }
    if (peer && !contains(r, peer)) continue;
    const allow = (e.RuleAction ?? '').toLowerCase() === 'allow';
    return {
      verdict: allow ? 'allow' : 'block', nodeId: nacl.id,
      reason: `${nacl.nativeId} ${allow ? 'allows' : 'denies'} ${trafficText(t)} ${egress ? 'out to' : 'in from'} ${rangeText(peer ?? ALL)} (first matching entry).`,
      rule: naclEntryText(e),
    };
  }
  return { verdict: 'block', nodeId: nacl.id, reason: `No entry of ${nacl.nativeId} matches — the implicit deny applies.` };
}

// ---------------------------------------------------------------------------------------------------------------
// the walk

class Walk {
  readonly hops: Hop[] = [];
  outcome: Outcome | null = null;
  outside?: OutsideRef;
  private readonly seen = new Set<string>();

  constructor(readonly idx: GraphIndex, public t: Traffic, readonly dest: Dest) {}

  hop(h: Hop): void {
    this.hops.push(h);
  }

  check(c: Check, title: string): boolean {
    this.hop({ nodeId: c.nodeId, edgeId: c.edgeId, verdict: c.verdict, title, reason: c.reason, rule: c.rule });
    if (c.verdict === 'block') this.outcome = 'blocked';
    return c.verdict !== 'block';
  }

  end(outcome: Outcome, h?: Hop): void {
    if (h) this.hop(h);
    this.outcome = outcome;
  }

  leave(id: string): void {
    const n = this.idx.node(id);
    this.outside = outsideRef(this.idx, id);
    this.end('leaves-blueprint', {
      nodeId: n ? id : this.hops[this.hops.length - 1]?.nodeId ?? id, verdict: 'info',
      title: `Outside this blueprint: ${n ? nameOf(n) : id.split(':').slice(4).join(':')}`,
      reason: n ? `${n.nativeId} is ${n.visibility === 'stub' ? 'only known by reference' : 'outside the blueprint'} — add it and rescan to follow the path further.` : `The route target ${id.split(':').slice(4).join(':')} was not collected.`,
    });
  }

  /** Cycle guard: false (and an unknown end) the second time a decision point is visited. */
  once(id: string): boolean {
    if (this.seen.has(id) || this.hops.length > 60) {
      this.end('unknown', { nodeId: id, verdict: 'unknown', title: 'Routing loop', reason: 'The path returns to a route table it already used.' });
      return false;
    }
    this.seen.add(id);
    return true;
  }

  get done(): boolean {
    return this.outcome !== null;
  }

  result(label?: string): PathResult {
    const outcome = this.outcome ?? 'unknown';
    const uncertain = this.hops.some(h => h.verdict === 'unknown');
    const last = this.hops[this.hops.length - 1];
    const blockedAt = [...this.hops].reverse().find(h => h.verdict === 'block');
    const summary = outcome === 'reaches' ? `Reaches ${this.dest.label}${uncertain ? ' — some checks could not be verified' : ''}`
      : outcome === 'blocked' ? `Blocked at ${blockedAt?.title ?? last?.title ?? 'an unknown hop'}`
      : outcome === 'leaves-blueprint' ? `Leaves the blueprint at ${last?.title.replace(/^Outside this blueprint: /, '') ?? 'an outside resource'}`
      : `Could not be determined${last ? `: ${last.reason}` : ''}`;
    return { outcome, hops: this.hops, outside: this.outside, summary, uncertain: uncertain && outcome !== 'blocked' ? true : undefined, label };
  }
}

/** isPublic: the source has a public address (null = not known, e.g. tracing from a whole subnet). */
interface Source { range: Range | null; sgIds: string[]; isPublic: boolean | null; subnetId?: string }

/** Route out of a subnet: NACL outbound, then its route table. */
function fromSubnet(w: Walk, subnet: GraphNode, src: Source): void {
  const { idx, dest } = w;
  const network = networkOf(idx, subnet);
  const destSubnet = dest.eni ? subnetOf(idx, dest.eni) : undefined;
  if (destSubnet?.id === subnet.id) return deliver(w, network!, src, subnet);
  if (!w.check(evalNacl(idx, subnet, true, dest.range, w.t), 'Network ACL outbound')) return;
  const rt = routeTableOf(idx, subnet);
  if (!rt) return w.end('unknown', { nodeId: subnet.id, verdict: 'unknown', title: 'No route table', reason: `${nameOf(subnet)} has no route table association in the graph.` });
  followTable(w, rt, network, src);
}

function followTable(w: Walk, rt: GraphNode, network: GraphNode | undefined, src: Source, assumed?: string): void {
  const { idx, dest } = w;
  if (!w.once(rt.id)) return;
  const choice = lookupRoute(idx, rt, dest.range, network?.cidrs ?? []);
  if (!choice) return w.end('blocked', { nodeId: rt.id, verdict: 'block', title: `Route table ${nameOf(rt)}`, reason: `No route covers ${destText(dest)}.` });
  if (choice.blackhole) return w.end('blocked', { nodeId: rt.id, edgeId: choice.edge?.id, verdict: 'block', title: `Route table ${nameOf(rt)}`, reason: 'The matching route is a blackhole — its target no longer exists.', rule: routeText(idx, choice) });
  w.hop({ nodeId: rt.id, edgeId: choice.edge?.id, verdict: assumed ? 'info' : 'allow', title: `Route table ${nameOf(rt)}${assumed ? ' (assumed)' : ''}`, reason: assumed ?? `Longest-prefix match for ${destText(dest)}.`, rule: routeText(idx, choice) });
  if (choice.target === 'local') return deliver(w, network!, src);
  followTarget(w, choice.target, network, src);
}

function followTarget(w: Walk, targetId: string, network: GraphNode | undefined, src: Source): void {
  const { idx, dest } = w;
  const target = idx.node(targetId);
  if (!target) return w.leave(targetId);
  switch (target.kind) {
    case 'internet-gateway': {
      if (!dest.isPublic) return w.end('blocked', { nodeId: target.id, verdict: 'block', title: `Internet gateway ${nameOf(target)}`, reason: `${destText(dest)} is a private address; an internet gateway does not route it.` });
      if (src.isPublic === false) return w.end('blocked', { nodeId: target.id, verdict: 'block', title: `Internet gateway ${nameOf(target)}`, reason: 'The source has no public IP address, so the internet gateway cannot translate it.' });
      w.hop(src.isPublic === null
        ? { nodeId: target.id, verdict: 'unknown', title: `Internet gateway ${nameOf(target)}`, reason: 'Forwards to the internet — only for sources with a public IP, which is not known when tracing from a subnet or network.' }
        : { nodeId: target.id, verdict: 'allow', title: `Internet gateway ${nameOf(target)}`, reason: 'Forwards to the internet.' });
      return w.end('reaches', { nodeId: dest.nodeId && idx.node(dest.nodeId) ? dest.nodeId : INTERNET_ID, verdict: 'allow', title: `Reaches ${dest.label}`, reason: 'Destination reached.' });
    }
    case 'nat-gateway': {
      const state = target.state ?? target.nativeState;
      if (state && !['available', 'pending'].includes(state)) return w.end('blocked', { nodeId: target.id, verdict: 'block', title: `NAT gateway ${nameOf(target)}`, reason: `The NAT gateway is ${state}.` });
      const priv = str(target.attrs?.['connectivityType']) === 'private';
      const pub = idx.out(target.id, 'exits-via').map(e => str(idx.node(e.to)?.attrs?.['ip'])).filter(Boolean);
      w.hop({ nodeId: target.id, verdict: 'allow', title: `NAT gateway ${nameOf(target)}`, reason: priv ? 'Private NAT: translates to its private address.' : `Translates the source to ${pub.join(', ') || 'its public IP'}.` });
      const natSubnet = subnetOf(idx, target);
      if (!natSubnet) return w.end('unknown', { nodeId: target.id, verdict: 'unknown', title: 'NAT subnet unknown', reason: 'The NAT gateway’s subnet is not in the graph.' });
      const natIp = strs(target.attrs?.['privateIps'])[0];
      return fromSubnet(w, natSubnet, { range: natIp ? cidrRange(`${natIp}/32`) : cidrRange(natSubnet.cidrs?.[0]), sgIds: [], isPublic: !priv, subnetId: natSubnet.id });
    }
    case 'hub': return viaHub(w, target, network, src);
    case 'hub-attachment': return viaHub(w, idx.node(target.parentId ?? '') ?? target, network, src);
    case 'peering': return viaPeering(w, target, network, src);
    case 'vpn-gateway': {
      if (!isUsable(target)) return w.leave(target.id);
      w.hop({ nodeId: target.id, verdict: 'allow', title: `VPN gateway ${nameOf(target)}`, reason: 'Sends the traffic over site-to-site VPN.' });
      const vpn = idx.in(target.id, 'attaches').map(e => idx.node(e.from)).find(x => x?.kind === 'vpn-connection');
      return toSite(w, vpn);
    }
    case 'endpoint': {
      const type = (str(target.attrs?.['endpointType']) ?? '').toLowerCase();
      if (type === 'gateway') {
        return w.end('reaches', { nodeId: target.id, verdict: 'allow', title: `Gateway endpoint ${nameOf(target)}`, reason: `Delivered to ${str(target.attrs?.['serviceName']) ?? 'the AWS service'} through the gateway endpoint.` });
      }
      w.hop({ nodeId: target.id, verdict: 'info', title: `Inspection endpoint ${nameOf(target)}`, reason: 'Traffic is sent through the inspection endpoint; firewall policy is not evaluated.' });
      const sub = subnetOf(idx, target);
      if (!sub) return w.end('unknown', { nodeId: target.id, verdict: 'unknown', title: 'Endpoint subnet unknown', reason: 'The endpoint’s subnet is not in the graph.' });
      const rt = routeTableOf(idx, sub);
      if (!rt) return w.end('unknown', { nodeId: sub.id, verdict: 'unknown', title: 'No route table', reason: `${nameOf(sub)} has no route table association in the graph.` });
      return followTable(w, rt, networkOf(idx, sub), src);
    }
    case 'egress-only-gateway':
      return w.end('unknown', { nodeId: target.id, verdict: 'unknown', title: `Egress-only gateway ${nameOf(target)}`, reason: 'Egress-only gateways carry IPv6 only; IPv6 paths are not modeled.' });
    default:
      return w.end('unknown', { nodeId: target.id, verdict: 'unknown', title: `${nameOf(target)}`, reason: `Forwarding through a ${target.kind} is not modeled.` });
  }
}

function toSite(w: Walk, vpn: GraphNode | undefined): void {
  const { idx } = w;
  if (!vpn) return w.end('unknown', { nodeId: w.hops[w.hops.length - 1].nodeId, verdict: 'unknown', title: 'VPN connection unknown', reason: 'No VPN connection found for this gateway.' });
  const up = num(vpn.attrs?.['tunnelsUp']);
  const total = num(vpn.attrs?.['tunnelsTotal']);
  if (total && up === 0) return w.end('blocked', { nodeId: vpn.id, verdict: 'block', title: `VPN ${nameOf(vpn)}`, reason: 'All tunnels are down.' });
  w.hop({ nodeId: vpn.id, verdict: total && (up ?? 0) < total ? 'unknown' : 'allow', title: `VPN ${nameOf(vpn)}`, reason: total ? `${up ?? 0}/${total} tunnels up.` : 'Tunnel status not collected.' });
  const site = idx.out(vpn.id, 'tunnels-to').map(e => idx.node(e.to)).find(Boolean);
  w.outside = site ? outsideRef(idx, site.id) : outsideRef(idx, vpn.id);
  w.end('leaves-blueprint', {
    nodeId: site?.id ?? vpn.id, verdict: 'info', title: `Leaves AWS to ${nameOf(site, 'the remote site')}`,
    reason: `Delivered over the VPN to ${site ? `${nameOf(site)}${str(site.attrs?.['ip']) ? ` (${str(site.attrs?.['ip'])})` : ''}` : 'the customer gateway'}; what happens there is not visible.`,
  });
}

function viaHub(w: Walk, hub: GraphNode, network: GraphNode | undefined, src: Source): void {
  const { idx, dest } = w;
  if (!isUsable(hub)) return w.leave(hub.id);
  const attachments = network ? idx.out(network.id, 'attaches').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'hub-attachment' && x.parentId === hub.id) : [];
  const att = attachments[0];
  w.hop({ nodeId: hub.id, verdict: 'allow', title: `Transit hub ${nameOf(hub)}`, reason: att ? `Enters through attachment ${att.nativeId}.` : 'Enters the transit hub.' });
  if (hub.visibility === 'partial') return w.end('unknown', { nodeId: hub.id, verdict: 'unknown', title: 'Hub route tables not readable', reason: 'This scope cannot read the transit hub’s route tables (owned by another account).' });
  if (!att) return w.end('unknown', { nodeId: hub.id, verdict: 'unknown', title: 'Hub attachment unknown', reason: 'No attachment from this network to the hub is in the graph.' });
  hubRoute(w, hub, att, src);
}

function hubRoute(w: Walk, hub: GraphNode, att: GraphNode, src: Source): void {
  const { idx, dest } = w;
  const defaultRt = str(hub.attrs?.['defaultAssociationRouteTable']);
  const rt = idx.out(att.id, 'associated').map(e => idx.node(e.to)).find(x => x?.kind === 'hub-route-table')
    ?? idx.children(hub.id).find(c => c.kind === 'hub-route-table' && (c.nativeId === defaultRt || c.attrs?.['defaultAssociation'] === true));
  if (!rt) return w.end('unknown', { nodeId: att.id, verdict: 'unknown', title: 'No hub route table', reason: `Attachment ${att.nativeId} has no associated route table in the graph.` });
  if (!w.once(rt.id)) return;
  const choice = lookupRoute(idx, rt, dest.range, []);
  if (!choice) return w.end('blocked', { nodeId: rt.id, verdict: 'block', title: `Hub route table ${nameOf(rt)}`, reason: `No route covers ${destText(dest)}.` });
  if (choice.blackhole) return w.end('blocked', { nodeId: rt.id, verdict: 'block', title: `Hub route table ${nameOf(rt)}`, reason: 'The matching route is a blackhole.', rule: routeText(idx, choice) });
  w.hop({ nodeId: rt.id, edgeId: choice.edge?.id, verdict: 'allow', title: `Hub route table ${nameOf(rt)}`, reason: `Longest-prefix match for ${destText(dest)}.`, rule: routeText(idx, choice) });
  const out = idx.node(choice.target);
  if (!out) return w.leave(choice.target);
  if (out.id === att.id) return w.end('blocked', { nodeId: out.id, verdict: 'block', title: `Attachment ${nameOf(out)}`, reason: 'The hub routes the traffic back to the attachment it came from.' });
  const type = str(out.attrs?.['resourceType']) ?? '';
  w.hop({ nodeId: out.id, verdict: 'allow', title: `Attachment ${nameOf(out)}`, reason: `Leaves the hub to the ${type || 'attached'} ${str(out.attrs?.['resourceId']) ?? ''}.`.replace(/ \.$/, '.') });
  switch (type) {
    case 'vpc': {
      const net = idx.in(out.id, 'attaches').map(e => idx.node(e.from)).find(x => x?.kind === 'network');
      if (!net) return w.leave(`aws:-:${hub.region ?? '-'}:network:${str(out.attrs?.['resourceId']) ?? ''}`);
      if (!isUsable(net)) return w.leave(net.id);
      return arrive(w, net, src, 'hub', hub.id);
    }
    case 'vpn': return toSite(w, idx.in(out.id, 'attaches').map(e => idx.node(e.from)).find(x => x?.kind === 'vpn-connection'));
    case 'peering':
    case 'tgw-peering': {
      const peer = idx.out(out.id, 'peers').map(e => e.to)[0];
      return w.leave(peer ?? out.id);
    }
    default: {
      const ext = idx.in(out.id, 'attaches').map(e => idx.node(e.from)).find(Boolean);
      return w.leave(ext?.id ?? out.id);
    }
  }
}

function viaPeering(w: Walk, peering: GraphNode, network: GraphNode | undefined, src: Source): void {
  const { idx, dest } = w;
  const state = peering.state ?? peering.nativeState;
  if (state && state !== 'active') return w.end('blocked', { nodeId: peering.id, verdict: 'block', title: `Peering ${nameOf(peering)}`, reason: `The peering is ${state}.` });
  const sides = [...idx.in(peering.id, 'peers').map(e => e.from), ...idx.out(peering.id, 'peers').map(e => e.to)];
  const otherId = sides.find(id => id !== network?.id);
  w.hop({ nodeId: peering.id, verdict: 'allow', title: `Peering ${nameOf(peering)}`, reason: 'Crosses the VPC peering. The peer side’s route back is not checked.' });
  if (!otherId) return w.end('unknown', { nodeId: peering.id, verdict: 'unknown', title: 'Peer network unknown', reason: 'The other side of the peering is not in the graph.' });
  const other = idx.node(otherId);
  if (!isUsable(other)) return w.leave(otherId);
  if (!networkContains(other!, dest.range)) return w.end('blocked', { nodeId: other!.id, verdict: 'block', title: `Network ${nameOf(other)}`, reason: 'VPC peering is not transitive: the destination is not inside the peer network.' });
  arrive(w, other!, src, 'peering', peering.id);
}

/** Traffic arrives in a network from a hub or peering: deliver locally, or keep routing (hub only). */
function arrive(w: Walk, net: GraphNode, src: Source, via: 'hub' | 'peering', fromId: string): void {
  const { idx, dest } = w;
  w.hop({ nodeId: net.id, verdict: 'allow', title: `Network ${nameOf(net)}`, reason: `Arrives in ${net.nativeId}.` });
  if (networkContains(net, dest.range)) return deliver(w, net, { ...src, subnetId: undefined, sgIds: via === 'peering' ? src.sgIds : [] });
  if (via === 'peering') return w.end('blocked', { nodeId: net.id, verdict: 'block', title: 'Peering is not transitive', reason: 'Traffic arriving over a peering cannot be routed onward.' });
  // the attachment's own subnets are not collected: follow the network's route table that sends the destination onward
  const rank: Record<string, number> = { 'nat-gateway': 0, endpoint: 1, 'firewall-service': 1, 'internet-gateway': 2 };
  let best: { rt: GraphNode; choice: RouteChoice; r: number } | undefined;
  for (const rt of idx.children(net.id).filter(c => c.kind === 'route-table')) {
    const c = lookupRoute(idx, rt, dest.range, net.cidrs ?? []);
    if (!c || c.blackhole || c.target === 'local' || c.target === fromId) continue;
    const r = rank[idx.node(c.target)?.kind ?? ''] ?? 3;
    if (!best || r < best.r) best = { rt, choice: c, r };
  }
  if (!best) return w.end('unknown', { nodeId: net.id, verdict: 'unknown', title: 'Onward route unknown', reason: `No route table in ${nameOf(net)} sends ${destText(dest)} onward.` });
  followTable(w, best.rt, net, { ...src, sgIds: [] },
    `The hub attachment’s subnets are not collected; following ${nameOf(best.rt)}, the route table in ${nameOf(net)} that sends ${destText(dest)} onward.`);
}

/** Final delivery inside `network`: destination subnet NACL inbound, then the destination's security groups. */
function deliver(w: Walk, network: GraphNode, src: Source, sameSubnet?: GraphNode): void {
  const { idx, dest } = w;
  const destSubnet = dest.eni ? subnetOf(idx, dest.eni) : smallestSubnetContaining(idx, network, dest.range);
  if (sameSubnet) {
    w.hop({ nodeId: sameSubnet.id, verdict: 'info', title: 'Same subnet', reason: 'Source and destination share a subnet — network ACLs do not apply.' });
  } else if (destSubnet) {
    if (!w.check(evalNacl(idx, destSubnet, false, src.range, w.t), `Network ACL inbound (${nameOf(destSubnet)})`)) return;
  }
  if (dest.eni) {
    const c = evalSgs(idx, sgsOf(idx, dest.eni), 'ingress', src.range, src.sgIds, w.t, dest.eni.id);
    if (!w.check(c, 'Security group ingress')) return;
    const target = dest.nodeId && idx.node(dest.nodeId) ? dest.nodeId : dest.eni.id;
    return w.end('reaches', { nodeId: target, verdict: 'allow', title: `Reaches ${dest.label}`, reason: 'Destination reached.' });
  }
  if (destSubnet && dest.nodeId && (dest.nodeId === destSubnet.id || dest.nodeId === network.id)) {
    return w.end('reaches', { nodeId: dest.nodeId, verdict: 'allow', title: `Reaches ${dest.label}`, reason: 'Delivered into the destination range; no interface security group to check.' });
  }
  w.end('unknown', {
    nodeId: destSubnet?.id ?? network.id, verdict: 'unknown', title: `No interface with ${destText(dest)}`,
    reason: `The address is inside ${nameOf(destSubnet ?? network)}, but no collected interface has it — security groups cannot be checked.`,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// entry points

function traffic(q: { protocol?: Protocol; port?: number }): Traffic {
  return { proto: q.protocol ?? 'tcp', port: q.port ?? 443 };
}

function resolveDest(idx: GraphIndex, to: PathTarget): Dest | string {
  if (to.kind === 'internet') return { range: ALL, label: 'the internet', isPublic: true, nodeId: INTERNET_ID };
  if (to.kind === 'ip') {
    const n = ipNum(to.ip);
    if (n === null) return `"${to.ip}" is not an IPv4 address.`;
    const range: Range = [n, n];
    const eni = eniByIp(idx, to.ip.trim());
    if (eni) return { range, label: `${to.ip} (${nameOf(eni)})`, isPublic: isPublicRange(range), nodeId: eni.id, eni };
    return { range, label: to.ip.trim(), isPublic: isPublicRange(range) };
  }
  const node = idx.node(to.id);
  if (!node) return 'The destination is not in this snapshot.';
  if (node.id === INTERNET_ID) return { range: ALL, label: 'the internet', isPublic: true, nodeId: INTERNET_ID };
  const eni = interfacesOf(idx, node)[0];
  const ip = eni ? ipsOf(eni)[0] : undefined;
  if (eni && ip) return { range: [ipNum(ip)!, ipNum(ip)!], label: nameOf(node), isPublic: false, nodeId: node.id, eni };
  const ipAttr = str(node.attrs?.['ip']);
  if (ipAttr && ipNum(ipAttr) !== null) { const v = ipNum(ipAttr)!; return { range: [v, v], label: `${nameOf(node)}`, isPublic: isPublicRange([v, v]), nodeId: node.id }; }
  const c = cidrRange(node.cidrs?.find(x => !!cidrRange(x)));
  if (c) return { range: c, label: nameOf(node), isPublic: isPublicRange(c), nodeId: node.id };
  return `${nameOf(node)} has no address in the graph to trace to.`;
}

/** Outbound path from a resource to the internet, an IP or another resource. Inbound queries return the first entry point. */
export function tracePath(idx: GraphIndex, q: PathQuery): PathResult {
  if (q.direction === 'inbound') {
    return traceInbound(idx, q)[0] ?? { outcome: 'unknown', hops: [], summary: 'No entry points into this resource were found in the graph.' };
  }
  const start = idx.node(q.from);
  const t = traffic(q);
  const d = resolveDest(idx, q.to ?? { kind: 'internet' });
  if (!start) return { outcome: 'unknown', hops: [], summary: 'The starting resource is not in this snapshot.' };
  if (typeof d === 'string') return { outcome: 'unknown', hops: [], summary: d };
  const w = new Walk(idx, t, d);
  w.hop({ nodeId: start.id, verdict: 'info', title: `From ${nameOf(start)}`, reason: `Tracing ${trafficText(t)} to ${d.label}.` });

  const enis = interfacesOf(idx, start);
  const eni = enis[0];
  if (eni) {
    const ip = ipsOf(eni)[0];
    const pub = publicIpOf(idx, eni);
    if (eni.id !== start.id) w.hop({ nodeId: eni.id, verdict: 'info', title: `Interface ${nameOf(eni)}`, reason: `Sends from ${ip ?? 'an unknown address'}${pub ? ` (public ${pub})` : ''}${enis.length > 1 ? `; ${enis.length} interfaces, tracing the first` : ''}.` });
    const sgs = sgsOf(idx, eni).length ? sgsOf(idx, eni) : sgsOf(idx, start);
    const destSgs = d.eni ? sgsOf(idx, d.eni).map(s => s.id) : [];
    const c = evalSgs(idx, sgs, 'egress', d.range, destSgs, t, eni.id);
    if (!w.check(c, 'Security group egress')) return w.result();
    const subnet = subnetOf(idx, eni);
    if (!subnet) { w.end('unknown', { nodeId: eni.id, verdict: 'unknown', title: 'Subnet unknown', reason: 'The interface’s subnet is not in the graph.' }); return w.result(); }
    fromSubnet(w, subnet, { range: ip ? [ipNum(ip)!, ipNum(ip)!] : cidrRange(subnet.cidrs?.[0]), sgIds: sgs.map(s => s.id), isPublic: !!pub, subnetId: subnet.id });
    return w.result();
  }

  if (start.kind === 'nat-gateway') {
    followTarget(w, start.id, networkOf(idx, start), { range: null, sgIds: [], isPublic: false });
    // the start hop already names the NAT; drop the duplicate NAT hop
    if (w.hops[1]?.nodeId === start.id) w.hops.splice(1, 1);
    return w.result();
  }

  if (start.kind === 'network') {
    const rt = mainRouteTable(idx, start);
    w.hop({ nodeId: start.id, verdict: 'unknown', title: 'Starting from a whole network', reason: 'No interface chosen: security groups and network ACLs are not evaluated; using the main route table.' });
    if (!rt) { w.end('unknown', { nodeId: start.id, verdict: 'unknown', title: 'No route table', reason: 'The network has no route table in the graph.' }); return w.result(); }
    followTable(w, rt, start, { range: cidrRange(start.cidrs?.[0]), sgIds: [], isPublic: null });
    return w.result();
  }

  const subnet = subnetOf(idx, start);
  if (!subnet) { w.end('unknown', { nodeId: start.id, verdict: 'unknown', title: 'No interface or subnet', reason: `${nameOf(start)} has no interface or subnet in the graph to trace from.` }); return w.result(); }
  if (start.kind !== 'subnet') w.hop({ nodeId: subnet.id, verdict: 'info', title: `Subnet ${nameOf(subnet)}`, reason: 'No interface collected for this resource: tracing from its subnet.' });
  w.hop({ nodeId: subnet.id, verdict: 'unknown', title: 'Security groups not evaluated', reason: 'Tracing from a subnet: no interface, so no security group applies.' });
  fromSubnet(w, subnet, { range: cidrRange(subnet.cidrs?.[0]), sgIds: [], isPublic: null, subnetId: subnet.id });
  return w.result();
}

// ---------------------------------------------------------------------------------------------------------------
// inbound

interface InTarget { node: GraphNode; eni: GraphNode; ip: string; subnet: GraphNode; network: GraphNode; sgs: GraphNode[]; dest: Dest }

export interface InboundQuery { from: string; protocol?: Protocol; port?: number }

/** Every entry point that can reach `q.from` (internet direct, public/internal LBs, hubs, peering, VGW VPN), one result each. */
export function traceInbound(idx: GraphIndex, q: InboundQuery): PathResult[] {
  const node = idx.node(q.from);
  if (!node) return [];
  const t = traffic(q);
  const eni = interfacesOf(idx, node)[0];
  const ip = eni ? ipsOf(eni)[0] : undefined;
  const subnet = eni ? subnetOf(idx, eni) : undefined;
  const network = subnet ? networkOf(idx, subnet) : undefined;
  const fail = (summary: string): PathResult[] => [{ outcome: 'unknown', hops: [{ nodeId: node.id, verdict: 'unknown', title: nameOf(node), reason: summary }], summary }];
  if (!eni || !ip || !subnet || !network) return fail(`${nameOf(node)} has no interface with an address in the graph — inbound paths need one.`);
  const v = ipNum(ip)!;
  const target: InTarget = {
    node, eni, ip, subnet, network, sgs: sgsOf(idx, eni).length ? sgsOf(idx, eni) : sgsOf(idx, node),
    dest: { range: [v, v], label: nameOf(node), isPublic: false, nodeId: node.id, eni },
  };
  const results: PathResult[] = [];
  const direct = inboundInternet(idx, target, t);
  if (direct) results.push(direct);
  results.push(...inboundLoadBalancers(idx, target, t));
  results.push(...inboundHubs(idx, target, t));
  results.push(...inboundPeering(idx, target, t));
  results.push(...inboundVgw(idx, target, t));
  const rank: Record<Outcome, number> = { reaches: 0, unknown: 1, 'leaves-blueprint': 2, blocked: 3 };
  return results.sort((a, b) => rank[a.outcome] - rank[b.outcome]);
}

/** Last leg: target subnet NACL inbound, target SGs, arrival. */
function finishInbound(w: Walk, tg: InTarget, srcRange: Range | null, srcSgs: string[], srcSubnetId?: string): void {
  const { idx } = w;
  if (srcSubnetId === tg.subnet.id) w.hop({ nodeId: tg.subnet.id, verdict: 'info', title: 'Same subnet', reason: 'Network ACLs do not apply within a subnet.' });
  else if (!w.check(evalNacl(idx, tg.subnet, false, srcRange, w.t), `Network ACL inbound (${nameOf(tg.subnet)})`)) return;
  if (!w.check(evalSgs(idx, tg.sgs, 'ingress', srcRange, srcSgs, w.t, tg.eni.id), 'Security group ingress')) return;
  w.end('reaches', { nodeId: tg.node.id, verdict: 'allow', title: `Reaches ${nameOf(tg.node)}`, reason: `${trafficText(w.t)} arrives at ${tg.ip}.` });
}

/** Does the subnet's route table send replies for `src` to `via`? Adds a hop; false = blocked. */
function returnRoute(w: Walk, tg: InTarget, src: Range | null, viaIds: string[], viaLabel: string): boolean {
  const { idx } = w;
  const rt = routeTableOf(idx, tg.subnet);
  if (!rt) { w.hop({ nodeId: tg.subnet.id, verdict: 'unknown', title: 'Return route', reason: 'The subnet has no route table in the graph.' }); return true; }
  if (!src) { w.hop({ nodeId: rt.id, verdict: 'unknown', title: `Return route (${nameOf(rt)})`, reason: `The source range is not known, so the route back via ${viaLabel} cannot be checked.` }); return true; }
  const c = lookupRoute(idx, rt, src, tg.network.cidrs ?? []);
  if (c && !c.blackhole && viaIds.includes(c.target)) {
    w.hop({ nodeId: rt.id, edgeId: c.edge?.id, verdict: 'allow', title: `Return route (${nameOf(rt)})`, reason: `Replies to ${rangeText(src)} go back via ${viaLabel}.`, rule: routeText(idx, c) });
    return true;
  }
  w.end('blocked', { nodeId: rt.id, edgeId: c?.edge?.id, verdict: 'block', title: `Return route (${nameOf(rt)})`, reason: `Replies to ${rangeText(src)} do not go back via ${viaLabel}${c ? '' : ' — no route matches'}.`, rule: c ? routeText(idx, c) : undefined });
  return false;
}

function igwOf(idx: GraphIndex, network: GraphNode): GraphNode | undefined {
  return idx.out(network.id, 'attaches').map(e => idx.node(e.to)).find(x => x?.kind === 'internet-gateway');
}

function inboundInternet(idx: GraphIndex, tg: InTarget, t: Traffic): PathResult | null {
  const pub = publicIpOf(idx, tg.eni);
  if (!pub) return null;
  const w = new Walk(idx, t, tg.dest);
  w.hop({ nodeId: INTERNET_ID, verdict: 'info', title: 'From the internet', reason: `Clients connect to ${pub}.` });
  const igw = igwOf(idx, tg.network);
  if (!igw) { w.end('blocked', { nodeId: tg.network.id, verdict: 'block', title: 'No internet gateway', reason: `${nameOf(tg.network)} has no internet gateway attached.` }); return w.result('Internet → public IP'); }
  w.hop({ nodeId: igw.id, verdict: 'allow', title: `Internet gateway ${nameOf(igw)}`, reason: `Translates ${pub} to ${tg.ip}.` });
  if (returnRoute(w, tg, ALL, [igw.id], nameOf(igw))) finishInbound(w, tg, ALL, []);
  return w.result(`Internet → ${pub}`);
}

function inboundLoadBalancers(idx: GraphIndex, tg: InTarget, t: Traffic): PathResult[] {
  const targetIds = new Set([tg.node.id, tg.eni.id, ...idx.in(tg.eni.id, 'attaches').map(e => e.from)]);
  const lbs = new Map<string, GraphEdge>();
  for (const id of targetIds) for (const e of idx.in(id, 'targets')) if (idx.node(e.from)?.kind === 'load-balancer' && !lbs.has(e.from)) lbs.set(e.from, e);
  const out: PathResult[] = [];
  for (const [lbId, edge] of lbs) {
    const lb = idx.node(lbId)!;
    const scheme = str(lb.attrs?.['scheme']) ?? '';
    const internet = scheme === 'internet-facing';
    const w = new Walk(idx, t, tg.dest);
    const lbSubnet = idx.out(lb.id, 'placed-in').map(e => idx.node(e.to)).find(x => x?.kind === 'subnet');
    const lbNet = networkOf(idx, lb) ?? tg.network;
    const clientRange: Range | null = internet ? ALL : cidrRange(lbNet.cidrs?.[0]);
    const label = `${internet ? 'Internet' : 'Internal clients'} → ${nameOf(lb)}`;
    if (internet) {
      w.hop({ nodeId: INTERNET_ID, verdict: 'info', title: 'From the internet', reason: `Clients connect to ${str(lb.attrs?.['dnsName']) ?? nameOf(lb)}.` });
      const igw = igwOf(idx, lbNet);
      if (!igw) { w.end('blocked', { nodeId: lbNet.id, verdict: 'block', title: 'No internet gateway', reason: `${nameOf(lbNet)} has no internet gateway attached.` }); out.push(w.result(label)); continue; }
      w.hop({ nodeId: igw.id, verdict: 'allow', title: `Internet gateway ${nameOf(igw)}`, reason: 'Admits traffic to the load balancer’s public addresses.' });
    } else {
      w.hop({ nodeId: lbNet.id, verdict: 'info', title: `From inside ${nameOf(lbNet)}`, reason: `Internal load balancer: clients in ${rangeText(clientRange)}.` });
    }
    const listeners = Array.isArray(lb.attrs?.['listeners']) ? (lb.attrs!['listeners'] as { port?: number; protocol?: string }[]) : [];
    const listenerText = listeners.map(l => `${l.protocol ?? '?'}:${l.port ?? '?'}`).join(', ');
    if (!listeners.length) w.hop({ nodeId: lb.id, verdict: 'unknown', title: `Load balancer ${nameOf(lb)}`, reason: 'Listeners were not collected.' });
    else if (t.proto !== 'all' && !listeners.some(l => l.port === t.port)) {
      w.end('blocked', { nodeId: lb.id, verdict: 'block', title: `Load balancer ${nameOf(lb)}`, reason: `No listener on port ${t.port}.`, rule: `listeners: ${listenerText}` });
      out.push(w.result(label));
      continue;
    } else w.hop({ nodeId: lb.id, verdict: 'allow', title: `Load balancer ${nameOf(lb)}`, reason: `Listener on port ${t.port}.`, rule: `listeners: ${listenerText}` });
    if (lbSubnet && !w.check(evalNacl(idx, lbSubnet, false, clientRange, t), `Network ACL inbound (${nameOf(lbSubnet)})`)) { out.push(w.result(label)); continue; }
    const lbSgs = sgsOf(idx, lb);
    if (lbSgs.length) {
      if (!w.check(evalSgs(idx, lbSgs, 'ingress', clientRange, [], t, lb.id), 'Load balancer security group ingress')) { out.push(w.result(label)); continue; }
    } else w.hop({ nodeId: lb.id, verdict: 'info', title: 'No load balancer security groups', reason: 'This load balancer has no security groups (e.g. NLB): client addresses reach the targets.' });
    const port = num(edge.attrs?.['port']);
    const health = str(edge.attrs?.['health']);
    const tt: Traffic = { proto: t.proto === 'all' ? 'all' : t.proto, port: port ?? t.port };
    w.t = tt;
    w.hop({ nodeId: lb.id, edgeId: edge.id, verdict: health && !['healthy', 'initial'].includes(health) ? 'unknown' : 'allow', title: `Forwards to target`, reason: `Target group ${str(edge.attrs?.['targetGroup']) ?? '?'} sends ${trafficText(tt)}${health ? `; target health: ${health}` : ''}.` });
    const lbEnis = interfacesOf(idx, lb);
    const lbSrc: Range | null = lbSgs.length || !internet
      ? (lbEnis.length === 1 && ipsOf(lbEnis[0])[0] ? [ipNum(ipsOf(lbEnis[0])[0])!, ipNum(ipsOf(lbEnis[0])[0])!] : cidrRange(lbSubnet?.cidrs?.[0]))
      : ALL;
    finishInbound(w, tg, lbSrc, lbSgs.map(s => s.id), lbSubnet?.id);
    out.push(w.result(label));
  }
  return out;
}

function inboundHubs(idx: GraphIndex, tg: InTarget, t: Traffic): PathResult[] {
  const out: PathResult[] = [];
  const atts = idx.out(tg.network.id, 'attaches').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'hub-attachment');
  for (const att of atts) {
    const hub = idx.node(att.parentId ?? '');
    if (!hub || !isUsable(hub)) continue;
    for (const rt of idx.children(hub.id).filter(c => c.kind === 'hub-route-table')) {
      const c = lookupRoute(idx, rt, tg.dest.range, []);
      if (!c || c.blackhole || c.target !== att.id) continue;
      for (const srcAtt of idx.in(rt.id, 'associated').map(e => idx.node(e.from)).filter((x): x is GraphNode => x?.kind === 'hub-attachment' && x.id !== att.id)) {
        const type = str(srcAtt.attrs?.['resourceType']) ?? '';
        const srcNode = type === 'peering' || type === 'tgw-peering'
          ? idx.node(idx.out(srcAtt.id, 'peers')[0]?.to ?? '')
          : idx.in(srcAtt.id, 'attaches').map(e => idx.node(e.from)).find(Boolean);
        let site: GraphNode | undefined;
        let srcRange: Range | null = null;
        if (srcNode?.kind === 'vpn-connection') {
          site = idx.out(srcNode.id, 'tunnels-to').map(e => idx.node(e.to)).find(Boolean);
          srcRange = cidrRange(strs(srcNode.attrs?.['staticRoutes'])[0]);
        } else if (srcNode?.kind === 'network') srcRange = cidrRange(srcNode.cidrs?.find(x => !!cidrRange(x)));
        const origin = site ?? srcNode ?? srcAtt;
        const label = `${nameOf(origin)} → ${nameOf(hub)}`;
        const w = new Walk(idx, t, tg.dest);
        w.hop({ nodeId: origin.id, verdict: 'info', title: `From ${nameOf(origin)}`, reason: `${type === 'vpn' ? 'Site-to-site VPN' : type === 'vpc' ? 'Network' : 'Attachment'} on ${nameOf(hub)}${srcRange ? `, addresses ${rangeText(srcRange)}` : ''}${origin.visibility === 'stub' ? ' (outside the blueprint)' : ''}.` });
        if (srcNode?.kind === 'vpn-connection') {
          const up = num(srcNode.attrs?.['tunnelsUp']);
          const total = num(srcNode.attrs?.['tunnelsTotal']);
          if (total && up === 0) { w.end('blocked', { nodeId: srcNode.id, verdict: 'block', title: `VPN ${nameOf(srcNode)}`, reason: 'All tunnels are down.' }); out.push(w.result(label)); continue; }
          w.hop({ nodeId: srcNode.id, verdict: 'allow', title: `VPN ${nameOf(srcNode)}`, reason: total ? `${up ?? 0}/${total} tunnels up.` : 'Tunnel status not collected.' });
        }
        w.hop({ nodeId: srcAtt.id, verdict: 'allow', title: `Attachment ${nameOf(srcAtt)}`, reason: `Associated with ${nameOf(rt)}.` });
        w.hop({ nodeId: rt.id, edgeId: c.edge?.id, verdict: 'allow', title: `Hub route table ${nameOf(rt)}`, reason: `Routes ${rangeText(tg.dest.range)} to the target network’s attachment.`, rule: routeText(idx, c) });
        w.hop({ nodeId: att.id, verdict: 'allow', title: `Attachment ${nameOf(att)}`, reason: `Into ${nameOf(tg.network)}.` });
        if (returnRoute(w, tg, srcRange, [hub.id, att.id], nameOf(hub))) finishInbound(w, tg, srcRange, []);
        out.push(w.result(label));
      }
    }
  }
  return out;
}

function inboundPeering(idx: GraphIndex, tg: InTarget, t: Traffic): PathResult[] {
  const out: PathResult[] = [];
  const peerings = [...idx.out(tg.network.id, 'peers').map(e => e.to), ...idx.in(tg.network.id, 'peers').map(e => e.from)];
  for (const pid of new Set(peerings)) {
    const p = idx.node(pid);
    if (p?.kind !== 'peering') continue;
    const other = idx.node([...idx.in(p.id, 'peers').map(e => e.from), ...idx.out(p.id, 'peers').map(e => e.to)].find(id => id !== tg.network.id) ?? '');
    const a = p.attrs ?? {};
    const otherCidr = other?.cidrs?.find(x => !!cidrRange(x)) ?? (str(a['requesterVpc']) === tg.network.nativeId ? str(a['accepterCidr']) : str(a['requesterCidr']));
    const srcRange = cidrRange(otherCidr);
    const label = `${nameOf(other, 'peer network')} → ${nameOf(p)}`;
    const w = new Walk(idx, t, tg.dest);
    w.hop({ nodeId: other?.id ?? p.id, verdict: 'info', title: `From ${nameOf(other, 'the peer network')}`, reason: `Peer addresses ${rangeText(srcRange)}${other && !isUsable(other) ? ' — outside the blueprint, its routes are not checked' : ''}.` });
    const state = p.state ?? p.nativeState;
    if (state && state !== 'active') { w.end('blocked', { nodeId: p.id, verdict: 'block', title: `Peering ${nameOf(p)}`, reason: `The peering is ${state}.` }); out.push(w.result(label)); continue; }
    if (other && isUsable(other)) {
      const routes = idx.children(other.id).filter(c => c.kind === 'route-table').map(rt => ({ rt, c: lookupRoute(idx, rt, tg.dest.range, other.cidrs ?? []) }));
      const hit = routes.find(r => r.c?.target === p.id && !r.c.blackhole);
      if (!hit) { w.end('blocked', { nodeId: other.id, verdict: 'block', title: `Network ${nameOf(other)}`, reason: `No route table in ${nameOf(other)} sends ${rangeText(tg.dest.range)} to the peering.` }); out.push(w.result(label)); continue; }
      w.hop({ nodeId: hit.rt.id, edgeId: hit.c!.edge?.id, verdict: 'allow', title: `Route table ${nameOf(hit.rt)}`, reason: 'The peer side routes the target to the peering.', rule: routeText(idx, hit.c!) });
    }
    w.hop({ nodeId: p.id, verdict: 'allow', title: `Peering ${nameOf(p)}`, reason: 'Crosses the VPC peering.' });
    if (returnRoute(w, tg, srcRange, [p.id], nameOf(p))) finishInbound(w, tg, srcRange, []);
    out.push(w.result(label));
  }
  return out;
}

function inboundVgw(idx: GraphIndex, tg: InTarget, t: Traffic): PathResult[] {
  const out: PathResult[] = [];
  for (const vgw of idx.out(tg.network.id, 'attaches').map(e => idx.node(e.to)).filter((x): x is GraphNode => x?.kind === 'vpn-gateway')) {
    for (const vpn of idx.in(vgw.id, 'attaches').map(e => idx.node(e.from)).filter((x): x is GraphNode => x?.kind === 'vpn-connection')) {
      const site = idx.out(vpn.id, 'tunnels-to').map(e => idx.node(e.to)).find(Boolean);
      const srcRange = cidrRange(strs(vpn.attrs?.['staticRoutes'])[0]);
      const label = `${nameOf(site ?? vpn)} → ${nameOf(vgw)}`;
      const w = new Walk(idx, t, tg.dest);
      w.hop({ nodeId: site?.id ?? vpn.id, verdict: 'info', title: `From ${nameOf(site ?? vpn)}`, reason: `Site-to-site VPN${srcRange ? `, addresses ${rangeText(srcRange)}` : ''}.` });
      const up = num(vpn.attrs?.['tunnelsUp']);
      const total = num(vpn.attrs?.['tunnelsTotal']);
      if (total && up === 0) { w.end('blocked', { nodeId: vpn.id, verdict: 'block', title: `VPN ${nameOf(vpn)}`, reason: 'All tunnels are down.' }); out.push(w.result(label)); continue; }
      w.hop({ nodeId: vpn.id, verdict: 'allow', title: `VPN ${nameOf(vpn)}`, reason: total ? `${up ?? 0}/${total} tunnels up.` : 'Tunnel status not collected.' });
      w.hop({ nodeId: vgw.id, verdict: 'allow', title: `VPN gateway ${nameOf(vgw)}`, reason: `Into ${nameOf(tg.network)}.` });
      if (returnRoute(w, tg, srcRange, [vgw.id], nameOf(vgw))) finishInbound(w, tg, srcRange, []);
      out.push(w.result(label));
    }
  }
  return out;
}
