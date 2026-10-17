import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { INTERNET_ID, PathResult, traceInbound, tracePath } from '../src/app/model/path';
import { hubFixture } from './fixture';
import { ALLOW_ALL_NACL, id, withPublicLb, world } from './world';

const titles = (r: PathResult) => r.hops.map(h => h.title);
const kindsOn = (idx: GraphIndex, r: PathResult) => r.hops.map(h => idx.node(h.nodeId)?.kind);

describe('tracePath — synthetic hub fixture', () => {
  const idx = new GraphIndex(hubFixture().graph);
  const node = (kind: string, name: string) => idx.byName(kind, name)!;

  it('private subnet → NAT → IGW → internet reaches', () => {
    const r = tracePath(idx, { from: node('subnet', 'private-1a').id, direction: 'outbound' });
    expect(r.outcome).toBe('reaches');
    const ids = r.hops.map(h => h.nodeId);
    expect(ids).toContain('aws:-:us-east-1:route-table:rtb-egress-priv');
    expect(ids).toContain('aws:-:us-east-1:nat-gateway:nat-egress-1a');
    expect(ids).toContain('aws:-:us-east-1:route-table:rtb-egress-pub');
    expect(ids).toContain('aws:-:us-east-1:internet-gateway:igw-egress');
    expect(ids[ids.length - 1]).toBe(INTERNET_ID);
    // NAT before IGW
    expect(ids.indexOf('aws:-:us-east-1:nat-gateway:nat-egress-1a')).toBeLessThan(ids.indexOf('aws:-:us-east-1:internet-gateway:igw-egress'));
    // the fixture has no NACLs: reported, not fatal
    expect(r.uncertain).toBe(true);
    expect(r.hops.find(h => h.nodeId.includes('rtb-egress-priv'))!.rule).toContain('0.0.0.0/0 → nat-egress-1a');
  });

  it('workload path: the bastion has no egress rule, so its SG blocks 443 out', () => {
    const r = tracePath(idx, { from: node('workload', 'bastion-1').id, direction: 'outbound' });
    expect(kindsOn(idx, r).slice(0, 2)).toEqual(['workload', 'network-interface']);
    expect(r.outcome).toBe('blocked');
    const block = r.hops.find(h => h.verdict === 'block')!;
    expect(block.title).toBe('Security group egress');
    expect(block.nodeId).toBe('aws:-:us-east-1:security-group:sg-bastion');
  });

  it('spoke subnet egresses through the transit hub and the egress VPC', () => {
    const r = tracePath(idx, { from: node('subnet', 'app-1a').id, direction: 'outbound' });
    expect(r.outcome).toBe('reaches');
    const ids = r.hops.map(h => h.nodeId);
    for (const x of [
      'aws:-:us-east-1:route-table:rtb-prod-app', 'aws:-:us-east-1:hub:tgw-egress', 'aws:-:us-east-1:hub-route-table:tgw-rtb-tgw-egress',
      'aws:-:us-east-1:hub-attachment:tgw-attach-egress-tgw-egress', 'aws:-:us-east-1:network:vpc-egress',
      'aws:-:us-east-1:nat-gateway:nat-egress-1a', 'aws:-:us-east-1:internet-gateway:igw-egress', INTERNET_ID,
    ]) expect(ids).toContain(x);
    const assumed = r.hops.find(h => h.title.includes('(assumed)'))!;
    expect(assumed.verdict).toBe('info');
    expect(assumed.nodeId).toBe('aws:-:us-east-1:route-table:rtb-egress-priv');
  });

  it('a hub route into a stub spoke leaves the blueprint', () => {
    // domain-b's hub route table sends 0/0 to the egress VPC; send from the egress VPC's private subnet to the
    // shared-services stub instead by giving the hub route table a specific route (copy of the fixture, mutated)
    const g = hubFixture().graph;
    g.edges.push({ id: 'x1', kind: 'routes-to', from: 'aws:-:us-east-1:hub-route-table:tgw-rtb-tgw-egress', to: 'aws:-:us-east-1:hub-attachment:tgw-attach-shared-services', attrs: { destination: '10.60.0.0/16', state: 'active' } });
    const i2 = new GraphIndex(g);
    const r = tracePath(i2, { from: i2.byName('subnet', 'app-1a')!.id, to: { kind: 'ip', ip: '10.60.1.1' }, direction: 'outbound' });
    expect(r.outcome).toBe('leaves-blueprint');
    expect(r.outside?.networkNativeId).toBe('vpc-shared-services');
    expect(r.outside?.account).toBe('222222222222');
  });

  it('never throws on any node', () => {
    for (const n of idx.graph.nodes) {
      expect(() => tracePath(idx, { from: n.id, direction: 'outbound' })).not.toThrow();
      expect(() => traceInbound(idx, { from: n.id })).not.toThrow();
    }
  });
});

describe('tracePath — hand-built networks', () => {
  it('workload → NAT → IGW reaches with every check evaluated', () => {
    const idx = new GraphIndex(world().graph());
    const r = tracePath(idx, { from: id('workload', 'i-web'), direction: 'outbound' });
    expect(r.outcome).toBe('reaches');
    expect(r.uncertain).toBeUndefined();
    expect(kindsOn(idx, r)).toEqual(['workload', 'network-interface', 'security-group', 'nacl', 'route-table', 'nat-gateway', 'nacl', 'route-table', 'internet-gateway', 'external']);
    expect(r.hops.find(h => h.verdict === 'allow' && h.title === 'Security group egress')!.rule).toBe('egress all → 0.0.0.0/0');
  });

  it('SG egress blocks when only port 80 is open', () => {
    const w = world();
    w.drop(e => e.from === id('security-group', 'sg-web') && e.kind === 'allows');
    w.edge(id('security-group', 'sg-web'), 'allows', id('external', 'internet'), { direction: 'egress', protocol: 'tcp', fromPort: 80, toPort: 80 });
    const idx = new GraphIndex(w.graph());
    const blocked = tracePath(idx, { from: id('workload', 'i-web'), direction: 'outbound', port: 443 });
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.hops[blocked.hops.length - 1].title).toBe('Security group egress');
    expect(tracePath(idx, { from: id('workload', 'i-web'), direction: 'outbound', port: 80 }).outcome).toBe('reaches');
  });

  it('NACL: the lowest-numbered matching entry wins', () => {
    const deny = { RuleNumber: 90, Egress: true, Protocol: '6', RuleAction: 'deny', CidrBlock: '0.0.0.0/0', PortRange: { From: 443, To: 443 } };
    const w = world();
    w.get('nacl', 'acl-a').raw = { Entries: [deny, ...(ALLOW_ALL_NACL as object[])] };
    const r = tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), direction: 'outbound' });
    expect(r.outcome).toBe('blocked');
    const hop = r.hops[r.hops.length - 1];
    expect(hop.title).toBe('Network ACL outbound');
    expect(hop.rule).toBe('#90 deny tcp 443 → 0.0.0.0/0');

    const w2 = world();
    w2.get('nacl', 'acl-a').raw = { Entries: [{ ...deny, RuleNumber: 200 }, ...(ALLOW_ALL_NACL as object[])] };
    const r2 = tracePath(new GraphIndex(w2.graph()), { from: id('workload', 'i-web'), direction: 'outbound' });
    expect(r2.outcome).toBe('reaches');
    expect(r2.hops.find(h => h.title === 'Network ACL outbound')!.rule).toBe('#100 allow all → 0.0.0.0/0');
  });

  it('a blackhole route blocks', () => {
    const w = world();
    w.drop(e => e.from === id('route-table', 'rtb-app') && e.kind === 'routes-to');
    w.edge(id('route-table', 'rtb-app'), 'routes-to', id('nat-gateway', 'nat-gone'), { destination: '0.0.0.0/0', state: 'blackhole' });
    const r = tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), direction: 'outbound' });
    expect(r.outcome).toBe('blocked');
    expect(r.hops[r.hops.length - 1].reason).toMatch(/blackhole/);
    expect(r.hops[r.hops.length - 1].rule).toBe('0.0.0.0/0 → nat-gone [blackhole]');
  });

  it('longest prefix beats 0.0.0.0/0, and a stub peer leaves the blueprint', () => {
    const w = world();
    const pcx = w.node('peering', 'pcx-1', { region: 'global', state: 'active' });
    pcx.id = 'aws:-:global:peering:pcx-1';
    w.nodes.delete(id('peering', 'pcx-1'));
    w.nodes.set(pcx.id, pcx);
    const peer = w.node('network', 'vpc-peer', { cidrs: ['192.0.2.0/24'], visibility: 'stub', membership: 'outside-blueprint', account: '000000000002', region: 'r2' });
    w.edge(id('network', 'vpc-a'), 'peers', pcx.id);
    w.edge(pcx.id, 'peers', peer.id);
    w.edge(id('route-table', 'rtb-app'), 'routes-to', pcx.id, { destination: '192.0.2.0/24', state: 'active' });
    const idx = new GraphIndex(w.graph());
    const r = tracePath(idx, { from: id('workload', 'i-web'), to: { kind: 'ip', ip: '192.0.2.10' }, direction: 'outbound' });
    expect(r.hops.find(h => h.nodeId === id('route-table', 'rtb-app'))!.rule).toBe('192.0.2.0/24 → pcx-1');
    expect(r.outcome).toBe('leaves-blueprint');
    expect(r.outside).toEqual({ nodeId: peer.id, account: '000000000002', region: 'r2', networkNativeId: 'vpc-peer' });
    // a public address still takes the default route
    expect(tracePath(idx, { from: id('workload', 'i-web'), to: { kind: 'ip', ip: '198.51.100.99' }, direction: 'outbound' }).outcome).toBe('reaches');
  });

  it('a route to a target that was never collected leaves the blueprint', () => {
    const w = world();
    w.edge(id('route-table', 'rtb-app'), 'routes-to', id('hub', 'tgw-unknown'), { destination: '172.16.0.0/12', state: 'active' });
    const r = tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), to: { kind: 'ip', ip: '172.16.5.5' }, direction: 'outbound' });
    expect(r.outcome).toBe('leaves-blueprint');
    expect(r.outside?.nodeId).toBe(id('hub', 'tgw-unknown'));
  });

  it('same VPC: local route, destination NACL inbound and SG ingress (SG-to-SG)', () => {
    const idx = new GraphIndex(world().graph());
    const ok = tracePath(idx, { from: id('workload', 'i-web'), to: { kind: 'node', id: id('network-interface', 'eni-db') }, port: 5432, direction: 'outbound' });
    expect(ok.outcome).toBe('reaches');
    expect(ok.hops.find(h => h.nodeId === id('route-table', 'rtb-app'))!.rule).toBe('10.0.0.0/16 → local');
    expect(ok.hops.find(h => h.title === 'Security group ingress')!.rule).toBe('ingress tcp 5432 ← sg-web (web)');
    const no = tracePath(idx, { from: id('workload', 'i-web'), to: { kind: 'ip', ip: '10.0.3.20' }, port: 22, direction: 'outbound' });
    expect(no.outcome).toBe('blocked');
    expect(no.hops[no.hops.length - 1].title).toBe('Security group ingress');
  });

  it('private address via IGW is blocked; source without public IP on a public subnet is blocked', () => {
    const w = world();
    const eni = w.node('network-interface', 'eni-pub', { parentId: id('subnet', 'subnet-pub'), attrs: { privateIp: '10.0.1.30' } });
    w.edge(eni.id, 'uses', id('security-group', 'sg-web'));
    const idx = new GraphIndex(w.graph());
    const r = tracePath(idx, { from: eni.id, direction: 'outbound' });
    expect(r.outcome).toBe('blocked');
    expect(r.hops[r.hops.length - 1].reason).toMatch(/no public IP/);
  });

  it('a public subnet as the start reaches the internet, flagged: its sources may lack a public IP', () => {
    const idx = new GraphIndex(world().graph());
    const r = tracePath(idx, { from: id('subnet', 'subnet-pub'), direction: 'outbound' });
    expect(r.outcome).toBe('reaches');
    expect(r.uncertain).toBe(true);
    expect(r.hops.find(h => h.nodeId === id('internet-gateway', 'igw-a'))!.verdict).toBe('unknown');
  });

  it('missing data gives unknown verdicts, never a crash', () => {
    const w = world();
    w.drop(e => e.to === id('nacl', 'acl-a'));
    w.drop(e => e.from === id('security-group', 'sg-web') || e.to === id('security-group', 'sg-web'));
    w.edge(id('network-interface', 'eni-web'), 'uses', id('security-group', 'sg-web'));
    const r = tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), direction: 'outbound' });
    expect(r.hops.filter(h => h.verdict === 'unknown').map(h => h.title)).toEqual(['Security group egress', 'Network ACL outbound', 'Network ACL outbound']);
    expect(r.outcome).toBe('reaches');
    expect(r.uncertain).toBe(true);
    expect(tracePath(new GraphIndex(w.graph()), { from: 'nope', direction: 'outbound' }).outcome).toBe('unknown');
    expect(tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), to: { kind: 'ip', ip: 'not-an-ip' }, direction: 'outbound' }).outcome).toBe('unknown');
  });

  it('cycle guard: an inspection endpoint that routes back to the same table stops as a loop', () => {
    const w = world();
    w.drop(e => e.from === id('route-table', 'rtb-app') && e.kind === 'routes-to');
    const ep = w.node('endpoint', 'vpce-fw', { parentId: id('network', 'vpc-a'), attrs: { endpointType: 'GatewayLoadBalancer' } });
    w.edge(ep.id, 'placed-in', id('subnet', 'subnet-app'));
    w.edge(id('route-table', 'rtb-app'), 'routes-to', ep.id, { destination: '0.0.0.0/0', state: 'active' });
    const r = tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), direction: 'outbound' });
    expect(r.outcome).toBe('unknown');
    expect(titles(r)).toContain('Routing loop');
  });
});

describe('traceInbound', () => {
  it('internet → public LB → target allowed when the target SG admits the LB SG on the target port', () => {
    const w = withPublicLb(world());
    w.edge(id('security-group', 'sg-lb'), 'allows', id('security-group', 'sg-web'), { direction: 'ingress', protocol: 'tcp', fromPort: 8080, toPort: 8080 });
    const idx = new GraphIndex(w.graph());
    const rs = traceInbound(idx, { from: id('workload', 'i-web'), port: 443 });
    expect(rs).toHaveLength(1);
    const r = rs[0];
    expect(r.label).toBe('Internet → lb-pub');
    expect(r.outcome).toBe('reaches');
    expect(r.uncertain).toBeUndefined();
    expect(kindsOn(idx, r)).toEqual(['external', 'internet-gateway', 'load-balancer', 'nacl', 'security-group', 'load-balancer', 'nacl', 'security-group', 'workload']);
    expect(r.hops.find(h => h.title === 'Security group ingress')!.rule).toBe('ingress tcp 8080 ← sg-lb (lb)');
  });

  it('target SG that does not admit the LB blocks; a port without listener blocks at the LB', () => {
    const w = withPublicLb(world());
    w.edge(id('security-group', 'sg-lb'), 'allows', id('security-group', 'sg-web'), { direction: 'ingress', protocol: 'tcp', fromPort: 9090, toPort: 9090 });
    const idx = new GraphIndex(w.graph());
    const r = traceInbound(idx, { from: id('workload', 'i-web'), port: 443 })[0];
    expect(r.outcome).toBe('blocked');
    expect(r.hops[r.hops.length - 1].title).toBe('Security group ingress');
    const p = traceInbound(idx, { from: id('workload', 'i-web'), port: 8443 })[0];
    expect(p.outcome).toBe('blocked');
    expect(p.hops[p.hops.length - 1].rule).toBe('listeners: HTTPS:443');
  });

  it('direct internet entry needs a public IP and an ingress rule from 0.0.0.0/0', () => {
    const w = world();
    const eni = w.node('network-interface', 'eni-bastion', { parentId: id('subnet', 'subnet-pub'), attrs: { privateIp: '10.0.1.40', publicIp: '198.51.100.40' } });
    const sg = w.node('security-group', 'sg-bastion', { parentId: id('network', 'vpc-a') });
    w.edge(eni.id, 'uses', sg.id);
    w.edge(id('external', 'internet'), 'allows', sg.id, { direction: 'ingress', protocol: 'tcp', fromPort: 22, toPort: 22 });
    const idx = new GraphIndex(w.graph());
    const ssh = traceInbound(idx, { from: eni.id, port: 22 });
    expect(ssh[0].label).toBe('Internet → 198.51.100.40');
    expect(ssh[0].outcome).toBe('reaches');
    expect(traceInbound(idx, { from: eni.id, port: 443 })[0].outcome).toBe('blocked');
    // no public IP, no LB → no internet entry point
    expect(traceInbound(idx, { from: id('network-interface', 'eni-db'), port: 5432 })).toEqual([]);
  });

  it('VPN site over a transit hub reaches a target whose SG admits the site range', () => {
    const w = world();
    const hub = w.node('hub', 'tgw-1');
    const attA = w.node('hub-attachment', 'att-a', { parentId: hub.id, attrs: { resourceType: 'vpc', resourceId: 'vpc-a' } });
    const attV = w.node('hub-attachment', 'att-vpn', { parentId: hub.id, attrs: { resourceType: 'vpn', resourceId: 'vpn-1' } });
    const rt = w.node('hub-route-table', 'tgw-rtb-1', { parentId: hub.id });
    const vpn = w.node('vpn-connection', 'vpn-1', { attrs: { tunnelsUp: 2, tunnelsTotal: 2, staticRoutes: ['172.20.0.0/16'] } });
    const cgw = w.node('peer-gateway', 'cgw-1', { name: 'Site One', attrs: { ip: '203.0.113.50' } });
    w.edge(id('network', 'vpc-a'), 'attaches', attA.id);
    w.edge(vpn.id, 'attaches', attV.id);
    w.edge(vpn.id, 'tunnels-to', cgw.id);
    w.edge(attV.id, 'associated', rt.id);
    w.edge(rt.id, 'routes-to', attA.id, { destination: '10.0.0.0/16', state: 'active' });
    w.edge(id('route-table', 'rtb-app'), 'routes-to', hub.id, { destination: '172.20.0.0/16', state: 'active' });
    const cidr = w.node('cidr-block', '172.20.0.0/16', { provider: 'net', region: 'global', cidrs: ['172.20.0.0/16'] });
    w.edge(cidr.id, 'allows', id('security-group', 'sg-web'), { direction: 'ingress', protocol: 'tcp', fromPort: 443, toPort: 443 });
    const idx = new GraphIndex(w.graph());
    const rs = traceInbound(idx, { from: id('workload', 'i-web'), port: 443 });
    expect(rs).toHaveLength(1);
    expect(rs[0].label).toBe('Site One → tgw-1');
    expect(rs[0].outcome).toBe('reaches');
    expect(rs[0].hops.find(h => h.title.startsWith('Return route'))!.rule).toBe('172.20.0.0/16 → tgw-1');
    // outbound the other way (the VPC attachment's own hub route table): the site is outside AWS
    const rtA = w.node('hub-route-table', 'tgw-rtb-a', { parentId: hub.id });
    w.edge(attA.id, 'associated', rtA.id);
    w.edge(rtA.id, 'routes-to', attV.id, { destination: '172.20.0.0/16', state: 'active' });
    expect(tracePath(idx, { from: id('workload', 'i-web'), to: { kind: 'ip', ip: '172.20.1.1' }, direction: 'outbound' }).outcome).toBe('unknown');
    const out = tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), to: { kind: 'ip', ip: '172.20.1.1' }, direction: 'outbound' });
    expect(out.outcome).toBe('leaves-blueprint');
    expect(out.outside?.nodeId).toBe(cgw.id);
  });

  it('tracePath(direction inbound) returns the best entry point', () => {
    const w = withPublicLb(world());
    w.edge(id('security-group', 'sg-lb'), 'allows', id('security-group', 'sg-web'), { direction: 'ingress', protocol: 'tcp', fromPort: 8080, toPort: 8080 });
    expect(tracePath(new GraphIndex(w.graph()), { from: id('workload', 'i-web'), direction: 'inbound' }).outcome).toBe('reaches');
  });
});
