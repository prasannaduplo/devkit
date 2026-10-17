import type { GraphEdge, GraphNode, Json, NetworkGraph } from '../src/app/model/api-types';

// A tiny hand-written network for path/search tests. Invented names and documentation/private addresses only.
//
//   vpc-a 10.0.0.0/16 (igw-a)
//     subnet-pub 10.0.1.0/24  rtb-pub: 0/0 → igw-a         nat-a (10.0.1.5 → 198.51.100.7), lb-pub
//     subnet-app 10.0.2.0/24  rtb-app: 0/0 → nat-a          eni-web 10.0.2.10 (i-web, sg-web)
//     subnet-db  10.0.3.0/24  rtb-app                       eni-db 10.0.3.20 (sg-db)
//   every subnet → nacl-a (allow all, then the default deny)

export const id = (kind: string, native: string, region = 'r1'): string =>
  kind === 'external' ? 'net:-:global:external:internet' : kind === 'cidr-block' ? `net:-:global:cidr-block:${native}` : `aws:-:${region}:${kind}:${native}`;

export class World {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];
  private n = 0;

  node(kind: string, native: string, extra: Partial<GraphNode> = {}): GraphNode {
    const node: GraphNode = {
      id: id(kind, native), kind, provider: 'aws', nativeId: native, name: native, account: '000000000001', region: 'r1',
      visibility: 'full', membership: 'blueprint', ...extra,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  edge(from: string, kind: string, to: string, attrs: Record<string, Json> = {}): GraphEdge {
    const e: GraphEdge = { id: `e${++this.n}`, from, to, kind, attrs };
    this.edges.push(e);
    return e;
  }

  get(kind: string, native: string): GraphNode {
    return this.nodes.get(id(kind, native))!;
  }

  drop(pred: (e: GraphEdge) => boolean): void {
    this.edges = this.edges.filter(e => !pred(e));
  }

  graph(): NetworkGraph {
    return { schemaVersion: 1, nodes: [...this.nodes.values()], edges: this.edges, findings: [] };
  }
}

export const ALLOW_ALL_NACL: Json = [
  { RuleNumber: 100, Egress: true, Protocol: '-1', RuleAction: 'allow', CidrBlock: '0.0.0.0/0' },
  { RuleNumber: 32767, Egress: true, Protocol: '-1', RuleAction: 'deny', CidrBlock: '0.0.0.0/0' },
  { RuleNumber: 100, Egress: false, Protocol: '-1', RuleAction: 'allow', CidrBlock: '0.0.0.0/0' },
  { RuleNumber: 32767, Egress: false, Protocol: '-1', RuleAction: 'deny', CidrBlock: '0.0.0.0/0' },
];

export function world(): World {
  const w = new World();
  w.node('external', 'internet', { provider: 'net', name: 'Internet', region: 'global', attrs: { role: 'internet' } });
  const vpc = w.node('network', 'vpc-a', { cidrs: ['10.0.0.0/16'] });
  const igw = w.node('internet-gateway', 'igw-a', { parentId: vpc.id });
  w.edge(vpc.id, 'attaches', igw.id);
  const pub = w.node('subnet', 'subnet-pub', { parentId: vpc.id, cidrs: ['10.0.1.0/24'], attrs: { isPublic: true } });
  const app = w.node('subnet', 'subnet-app', { parentId: vpc.id, cidrs: ['10.0.2.0/24'], attrs: { isPublic: false } });
  const db = w.node('subnet', 'subnet-db', { parentId: vpc.id, cidrs: ['10.0.3.0/24'], attrs: { isPublic: false } });
  const rtPub = w.node('route-table', 'rtb-pub', { parentId: vpc.id, attrs: { main: false } });
  const rtApp = w.node('route-table', 'rtb-app', { parentId: vpc.id, attrs: { main: true } });
  w.edge(pub.id, 'associated', rtPub.id);
  w.edge(app.id, 'associated', rtApp.id);
  w.edge(db.id, 'associated', rtApp.id);
  w.edge(rtPub.id, 'routes-to', igw.id, { destination: '0.0.0.0/0', state: 'active' });
  const nat = w.node('nat-gateway', 'nat-a', { parentId: pub.id, state: 'available', attrs: { connectivityType: 'public', privateIps: ['10.0.1.5'] } });
  const pip = w.node('public-ip', 'eipalloc-a', { parentId: pub.id, name: '198.51.100.7', attrs: { ip: '198.51.100.7' } });
  w.edge(nat.id, 'exits-via', pip.id);
  w.edge(rtApp.id, 'routes-to', nat.id, { destination: '0.0.0.0/0', state: 'active' });
  const nacl = w.node('nacl', 'acl-a', { parentId: vpc.id, raw: { Entries: ALLOW_ALL_NACL } });
  for (const s of [pub, app, db]) w.edge(s.id, 'associated', nacl.id);

  const sgWeb = w.node('security-group', 'sg-web', { parentId: vpc.id, name: 'web' });
  const sgDb = w.node('security-group', 'sg-db', { parentId: vpc.id, name: 'db' });
  w.edge(sgWeb.id, 'allows', id('external', 'internet'), { direction: 'egress', protocol: 'all', fromPort: -1, toPort: -1 });
  w.edge(sgDb.id, 'allows', id('external', 'internet'), { direction: 'egress', protocol: 'all', fromPort: -1, toPort: -1 });
  w.edge(sgWeb.id, 'allows', sgDb.id, { direction: 'ingress', protocol: 'tcp', fromPort: 5432, toPort: 5432 });

  const web = w.node('network-interface', 'eni-web', { parentId: app.id, attrs: { privateIp: '10.0.2.10', privateIps: ['10.0.2.10'] } });
  const inst = w.node('workload', 'i-web', { parentId: app.id, attrs: { workloadType: 'ec2' } });
  w.edge(inst.id, 'attaches', web.id);
  w.edge(web.id, 'uses', sgWeb.id);
  const dbEni = w.node('network-interface', 'eni-db', { parentId: db.id, attrs: { privateIp: '10.0.3.20', privateIps: ['10.0.3.20'] } });
  w.edge(dbEni.id, 'uses', sgDb.id);
  return w;
}

/** Adds an internet-facing LB in subnet-pub targeting i-web on port 8080, with its own SG open on 443. */
export function withPublicLb(w: World, targetPort = 8080): World {
  const vpc = w.get('network', 'vpc-a');
  const lb = w.node('load-balancer', 'lb-pub', { parentId: vpc.id, attrs: { lbType: 'application', scheme: 'internet-facing', listeners: [{ port: 443, protocol: 'HTTPS' }] } });
  const sgLb = w.node('security-group', 'sg-lb', { parentId: vpc.id, name: 'lb' });
  w.edge(lb.id, 'placed-in', w.get('subnet', 'subnet-pub').id);
  w.edge(lb.id, 'uses', sgLb.id);
  w.edge(id('external', 'internet'), 'allows', sgLb.id, { direction: 'ingress', protocol: 'tcp', fromPort: 443, toPort: 443 });
  w.edge(lb.id, 'targets', w.get('workload', 'i-web').id, { port: targetPort, protocol: 'HTTP', health: 'healthy', targetGroup: 'tg-web' });
  return w;
}
