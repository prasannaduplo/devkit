import { describe, expect, it } from 'vitest';
import { Json } from '../src/app/model/api-types';
import { GraphIndex } from '../src/app/model/graph-index';
import { traceInbound, tracePath } from '../src/app/model/path';
import { search } from '../src/app/model/search';
import { evalNetworkPolicy, podsBehind, selectorMatches } from '../src/app/model/workloads';
import { World, id, withPublicLb, world } from './world';

// Hand-built EKS / ECS / Lambda workloads on the tiny world (invented names, private / documentation addresses):
//   i-node (subnet-app) eni-node 10.0.2.30 + pod IPs .31 (web/frontend-1) and .32 (kube-system/coredns-1), sg-web
//   service web/frontend → frontend-1, backs lb-pub; ingress web/shop → service; lb-pub exposes frontend-1 :8080
//   ecs task orders/1 on eni-task 10.0.2.40; lambda fn-report on eni-fn 10.0.2.50

function withK8s(w: World, policies: { egress?: Json; ingress?: Json; types?: string[] } | null = null): World {
  const vpc = w.get('network', 'vpc-a');
  const app = w.get('subnet', 'subnet-app');
  const eni = w.node('network-interface', 'eni-node', { parentId: app.id, attrs: { privateIp: '10.0.2.30', privateIps: ['10.0.2.30', '10.0.2.31', '10.0.2.32'] } });
  const node = w.node('workload', 'i-node', { parentId: app.id, attrs: { workloadType: 'ec2' } });
  w.edge(node.id, 'attaches', eni.id);
  w.edge(eni.id, 'uses', w.get('security-group', 'sg-web').id);
  const cluster = w.node('k8s-cluster', 'c1', { parentId: vpc.id, attrs: { readable: true } });
  const web = w.node('k8s-namespace', 'c1/web', { name: 'web', parentId: cluster.id, attrs: { namespace: 'web', labels: { 'kubernetes.io/metadata.name': 'web' } } });
  const ks = w.node('k8s-namespace', 'c1/kube-system', { name: 'kube-system', parentId: cluster.id, attrs: { namespace: 'kube-system', labels: { 'kubernetes.io/metadata.name': 'kube-system' } } });
  const fe = w.node('pod', 'c1/web/frontend-1', { name: 'frontend-1', parentId: web.id,
    attrs: { namespace: 'web', podIp: '10.0.2.31', podIps: ['10.0.2.31'], labels: { app: 'frontend' }, images: ['registry.example.com/shop-frontend:2.3'], ownerKind: 'Deployment', ownerName: 'frontend' } });
  const dns = w.node('pod', 'c1/kube-system/coredns-1', { name: 'coredns-1', parentId: ks.id,
    attrs: { namespace: 'kube-system', podIp: '10.0.2.32', podIps: ['10.0.2.32'], labels: { 'k8s-app': 'kube-dns' } } });
  w.edge(fe.id, 'runs-on', eni.id);
  w.edge(dns.id, 'runs-on', eni.id);
  const svc = w.node('k8s-service', 'c1/web/frontend', { name: 'frontend', parentId: web.id, attrs: { namespace: 'web', serviceType: 'ClusterIP', selector: { app: 'frontend' } } });
  w.edge(svc.id, 'selects', fe.id);
  const ing = w.node('ingress', 'c1/web/shop', { name: 'shop', parentId: web.id, attrs: { namespace: 'web', rules: [{ host: 'shop.example.com', path: '/', service: 'frontend', port: '80' }] } });
  w.edge(ing.id, 'backs', svc.id);
  if (policies) {
    const np = w.node('network-policy', 'c1/web/np', { name: 'np', parentId: web.id, attrs: {
      namespace: 'web', podSelector: {}, policyTypes: policies.types ?? ['Ingress', 'Egress'], ingress: policies.ingress ?? [], egress: policies.egress ?? [] } });
    w.edge(np.id, 'selects', fe.id);
  }
  return w;
}

function withLbToPod(w: World): World {
  withPublicLb(w);
  const lb = w.get('load-balancer', 'lb-pub');
  w.drop(e => e.kind === 'targets');
  w.edge(lb.id, 'exposes', w.get('pod', 'c1/web/frontend-1').id, { port: 8080, protocol: 'HTTP', health: 'healthy', targetGroup: 'tg-fe', targetIp: '10.0.2.31' });
  w.edge(w.get('ingress', 'c1/web/shop').id, 'backs', lb.id);
  w.edge(w.get('security-group', 'sg-lb').id, 'allows', w.get('security-group', 'sg-web').id, { direction: 'ingress', protocol: 'tcp', fromPort: 8080, toPort: 8080 });
  return w;
}

const idx = (w: World) => new GraphIndex(w.graph());
const pod = (w: World, name = 'c1/web/frontend-1') => w.get('pod', name).id;

describe('workload paths — outbound', () => {
  it('a pod with no NetworkPolicy sends from its own IP on the node ENI and reaches the internet', () => {
    const w = withK8s(world());
    const r = tracePath(idx(w), { from: pod(w), direction: 'outbound' });
    expect(r.outcome).toBe('reaches');
    const np = r.hops.find(h => h.title === 'NetworkPolicy egress')!;
    expect(np.verdict).toBe('info');
    const eniHop = r.hops.find(h => h.nodeId === w.get('network-interface', 'eni-node').id)!;
    expect(eniHop.reason).toContain('10.0.2.31');
    expect(eniHop.reason).toContain('node’s security groups');
  });

  it('a NetworkPolicy egress without an ipBlock covering the internet blocks, naming the engine caveat', () => {
    const w = withK8s(world(), { egress: [{ to: [{ ipBlock: { cidr: '10.0.0.0/8', except: [] } }], ports: [{ protocol: 'TCP', port: 443 }] }] });
    const r = tracePath(idx(w), { from: pod(w), direction: 'outbound' });
    expect(r.outcome).toBe('blocked');
    const h = r.hops.find(x => x.title === 'NetworkPolicy egress')!;
    expect(h.verdict).toBe('block');
    expect(h.reason).toContain('NetworkPolicy engine');
  });

  it('ipBlock 0.0.0.0/0 except the metadata address allows the internet on the listed port only', () => {
    const egress = [{ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.169.254/32'] } }], ports: [{ protocol: 'TCP', port: 443 }] }];
    const w = withK8s(world(), { egress });
    const ok = tracePath(idx(w), { from: pod(w), direction: 'outbound', protocol: 'tcp', port: 443 });
    expect(ok.outcome).toBe('reaches');
    expect(ok.hops.find(x => x.title === 'NetworkPolicy egress')!.rule).toContain('except 169.254.169.254/32');
    const no = tracePath(idx(w), { from: pod(w), direction: 'outbound', protocol: 'tcp', port: 80 });
    expect(no.outcome).toBe('blocked');
    const meta = tracePath(idx(w), { from: pod(w), to: { kind: 'ip', ip: '169.254.169.254' }, direction: 'outbound' });
    expect(meta.hops.find(x => x.title === 'NetworkPolicy egress')!.verdict).toBe('block');
  });

  it('namespaceSelector peers match a destination pod by its namespace labels', () => {
    const egress = [{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }], ports: [{ protocol: 'UDP', port: 53 }] }];
    const w = withK8s(world(), { egress });
    const r = tracePath(idx(w), { from: pod(w), to: { kind: 'node', id: pod(w, 'c1/kube-system/coredns-1') }, direction: 'outbound', protocol: 'udp', port: 53 });
    expect(r.hops.find(x => x.title === 'NetworkPolicy egress')!.verdict).toBe('allow');
    // by IP the pod is found too
    const byIp = tracePath(idx(w), { from: pod(w), to: { kind: 'ip', ip: '10.0.2.32' }, direction: 'outbound', protocol: 'udp', port: 53 });
    expect(byIp.hops.find(x => x.title === 'NetworkPolicy egress')!.verdict).toBe('allow');
    // and the internet is not a pod: the selector does not match it
    const out = tracePath(idx(w), { from: pod(w), direction: 'outbound', protocol: 'udp', port: 53 });
    expect(out.outcome).toBe('blocked');
  });

  it('a service or ingress as the start traces from the first pod behind it; as a target resolves to that pod', () => {
    const w = withK8s(world());
    const i = idx(w);
    const r = tracePath(i, { from: w.get('ingress', 'c1/web/shop').id, direction: 'outbound' });
    expect(r.hops[1].title).toBe('Pod frontend-1');
    expect(r.outcome).toBe('reaches');
    const to = tracePath(i, { from: w.get('workload', 'i-web').id, to: { kind: 'node', id: w.get('k8s-service', 'c1/web/frontend').id }, direction: 'outbound', protocol: 'tcp', port: 8080 });
    expect(to.summary).not.toContain('has no address');
    expect(r.hops.some(h => h.nodeId === w.get('network-interface', 'eni-node').id)).toBe(true);
  });

  it('ECS task and Lambda function trace from the interface they run on', () => {
    const w = world();
    const app = w.get('subnet', 'subnet-app');
    const te = w.node('network-interface', 'eni-task', { parentId: app.id, attrs: { privateIp: '10.0.2.40', privateIps: ['10.0.2.40'] } });
    w.edge(te.id, 'uses', w.get('security-group', 'sg-web').id);
    const task = w.node('ecs-task', 'task-1', { name: 'orders/1', attrs: { privateIp: '10.0.2.40' } });
    w.edge(task.id, 'runs-on', te.id);
    const fe = w.node('network-interface', 'eni-fn', { parentId: app.id, attrs: { privateIp: '10.0.2.50', privateIps: ['10.0.2.50'] } });
    w.edge(fe.id, 'uses', w.get('security-group', 'sg-web').id);
    const fn = w.node('lambda-function', 'fn-report', { parentId: w.get('network', 'vpc-a').id });
    w.edge(fn.id, 'runs-on', fe.id);
    const i = idx(w);
    expect(tracePath(i, { from: task.id, direction: 'outbound' }).outcome).toBe('reaches');
    const l = tracePath(i, { from: fn.id, direction: 'outbound' });
    expect(l.outcome).toBe('reaches');
    expect(l.hops[1].reason).toContain('10.0.2.50');
    // a workload whose interface was not collected is unknown, not traced from somewhere else
    const lost = w.node('ecs-task', 'task-2');
    expect(tracePath(idx(w), { from: lost.id, direction: 'outbound' }).outcome).toBe('unknown');
  });
});

describe('workload paths — inbound', () => {
  it('internet → load balancer → pod (ip target), with the NetworkPolicy ingress check at the pod', () => {
    const w = withLbToPod(withK8s(world(), { ingress: [{ from: [{ ipBlock: { cidr: '10.0.0.0/16', except: [] } }], ports: [{ protocol: 'TCP', port: 8080 }] }], types: ['Ingress'] }));
    const rs = traceInbound(idx(w), { from: pod(w), protocol: 'tcp', port: 443 });
    const viaLb = rs.find(r => r.label?.includes('lb-pub'))!;
    expect(viaLb.outcome).toBe('reaches');
    const np = viaLb.hops.find(h => h.title === 'NetworkPolicy ingress')!;
    expect(np.verdict).toBe('allow');
  });

  it('a policy that only admits pods blocks traffic arriving from the load balancer', () => {
    const w = withLbToPod(withK8s(world(), { ingress: [{ from: [{ podSelector: { matchLabels: { app: 'gateway' } } }] }], types: ['Ingress'] }));
    const viaLb = traceInbound(idx(w), { from: pod(w), protocol: 'tcp', port: 443 }).find(r => r.label?.includes('lb-pub'))!;
    expect(viaLb.outcome).toBe('blocked');
    expect(viaLb.hops[viaLb.hops.length - 1].title).toBe('NetworkPolicy ingress');
  });

  it('inbound to an ingress follows its load balancer to the pods behind it', () => {
    const w = withLbToPod(withK8s(world()));
    const rs = traceInbound(idx(w), { from: w.get('ingress', 'c1/web/shop').id, protocol: 'tcp', port: 443 });
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0].label).toContain('pod frontend-1');
    expect(rs[0].outcome).toBe('reaches');
    expect(rs.every(r => r.hops.some(h => h.nodeId === w.get('load-balancer', 'lb-pub').id))).toBe(true);
  });

  it('a service with no pods says so', () => {
    const w = withK8s(world());
    const lonely = w.node('k8s-service', 'c1/web/empty', { name: 'empty' });
    const rs = traceInbound(idx(w), { from: lonely.id });
    expect(rs[0].outcome).toBe('unknown');
    expect(rs[0].summary).toContain('selects no pod');
  });
});

describe('NetworkPolicy evaluation', () => {
  it('named ports and unknown peers are unknown, not allow', () => {
    const w = withK8s(world(), { egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [] } }], ports: [{ protocol: 'TCP', port: 'https' }] }] });
    const i = idx(w);
    const v = evalNetworkPolicy(i, w.get('pod', 'c1/web/frontend-1'), 'egress', { range: [0, 4294967295] }, { proto: 'tcp', port: 443 })!;
    expect(v.verdict).toBe('unknown');
    const u = evalNetworkPolicy(i, w.get('pod', 'c1/web/frontend-1'), 'egress', { range: null }, { proto: 'tcp', port: 443 })!;
    expect(u.verdict).toBe('unknown');
    expect(evalNetworkPolicy(i, w.get('pod', 'c1/kube-system/coredns-1'), 'egress', { range: null }, { proto: 'tcp', port: 443 })).toBeNull();
  });

  it('selectors follow Kubernetes semantics', () => {
    expect(selectorMatches({}, { a: '1' })).toBe(true);
    expect(selectorMatches({ matchExpressions: [{ key: 'a', operator: 'In', values: ['1', '2'] }] }, { a: '1' })).toBe(true);
    expect(selectorMatches({ matchExpressions: [{ key: 'a', operator: 'DoesNotExist', values: [] }] }, { a: '1' })).toBe(false);
    expect(selectorMatches({ matchLabels: { a: '2' } }, { a: '1' })).toBe(false);
  });

  it('podsBehind walks ingress → service → pods', () => {
    const w = withK8s(world());
    expect(podsBehind(idx(w), w.get('ingress', 'c1/web/shop')).map(p => p.name)).toEqual(['frontend-1']);
  });
});

describe('workload search', () => {
  const w = withK8s(world());
  const i = idx(w);
  it('finds pods by IP, image, namespace/name', () => {
    expect(search(i, '10.0.2.31')[0].nodeId).toBe(pod(w));
    expect(search(i, 'shop-frontend')[0].nodeId).toBe(pod(w));
    expect(search(i, 'web/frontend-1')[0].nodeId).toBe(pod(w));
    expect(search(i, 'shop.example.com')[0].nodeId).toBe(w.get('ingress', 'c1/web/shop').id);
    expect(id('pod', 'x')).toContain(':pod:');
  });
});
