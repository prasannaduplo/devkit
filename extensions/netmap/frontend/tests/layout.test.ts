import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphEdge, GraphNode, NetworkGraph } from '../src/app/model/api-types';
import { GraphIndex } from '../src/app/model/graph-index';
import { ElkLike, layoutView, Scene, toElk } from '../src/app/model/layout';
import { buildSeverity } from '../src/app/model/severity';
import { computeView, Level } from '../src/app/model/zoom';
import { hubFixture } from './fixture';

const elk = new ELK() as unknown as ElkLike;

function checkScene(scene: Scene, nodeCount: number): void {
  expect(scene.boxes).toHaveLength(nodeCount);
  expect(scene.width).toBeGreaterThan(0);
  const byId = new Map(scene.boxes.map(b => [b.id, b]));
  for (const b of scene.boxes) for (const v of [b.x, b.y, b.w, b.h]) expect(Number.isFinite(v)).toBe(true);
  for (const e of scene.edges) {
    expect(e.points.length).toBeGreaterThanOrEqual(2);
    expect(e.d.startsWith('M')).toBe(true);
    for (const p of e.points) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(byId.has(e.from) && byId.has(e.to)).toBe(true);
  }
  // containers are drawn before (under) leaves
  const firstLeaf = scene.boxes.findIndex(b => !b.container);
  if (firstLeaf >= 0) expect(scene.boxes.slice(firstLeaf).every(b => !b.container)).toBe(true);
}

function checkContainment(scene: Scene, parents: Map<string, string | undefined>): void {
  const byId = new Map(scene.boxes.map(b => [b.id, b]));
  for (const b of scene.boxes) {
    const pid = parents.get(b.id);
    if (!pid) continue;
    const p = byId.get(pid)!;
    expect(b.x).toBeGreaterThanOrEqual(p.x - 0.5);
    expect(b.y).toBeGreaterThanOrEqual(p.y - 0.5);
    expect(b.x + b.w).toBeLessThanOrEqual(p.x + p.w + 0.5);
    expect(b.y + b.h).toBeLessThanOrEqual(p.y + p.h + 0.5);
  }
}

describe('layout', () => {
  const idx = new GraphIndex(hubFixture().graph);
  const ctx = buildSeverity(idx);

  for (const level of [1, 2, 3] as Level[]) {
    it(`lays out L${level} of the synthetic hub`, async () => {
      const view = computeView(idx, level);
      const scene = await layoutView(view, elk, ctx);
      checkScene(scene, view.nodes.length);
      checkContainment(scene, new Map(view.nodes.map(n => [n.id, n.parentId])));
      expect(scene.edges.length).toBeGreaterThan(0);
    });
  }

  it('L1 marks icons, chokepoint and severity on boxes', async () => {
    const scene = await layoutView(computeView(idx, 1), elk, ctx);
    const egress = scene.boxes.find(b => b.label === 'egress')!;
    expect(egress.chokepoint).toBe(true);
    expect(egress.severity).toBe('bad');
    expect(scene.boxes.find(b => b.label === 'Internet')!.icon).toBe('internet');
    expect(scene.boxes.find(b => /VPN sites?$/.test(b.label))!.icon).toBe('site');
  });

  it('L4 focused on one network', async () => {
    const egress = idx.byName('network', 'egress')!;
    const view = computeView(idx, 4, egress.id);
    const scene = await layoutView(view, elk, ctx);
    checkScene(scene, view.nodes.length);
    expect(scene.boxes.filter(b => b.boundary).length).toBeGreaterThan(0);
    expect(scene.boxes.find(b => b.kind === 'subnet' && b.variant === 'public')).toBeDefined();
  });

  it('returns an empty scene when L4 needs a focus', async () => {
    expect((await layoutView(computeView(idx, 4), elk, ctx)).boxes).toHaveLength(0);
  });

  it('builds ELK input with containers and edges at the root', () => {
    const elkIn = toElk(computeView(idx, 1));
    expect(elkIn.layoutOptions?.['elk.hierarchyHandling']).toBe('INCLUDE_CHILDREN');
    expect(elkIn.children!.some(c => (c.children?.length ?? 0) > 0)).toBe(true);
    expect(elkIn.edges!.length).toBeGreaterThan(0);
  });

  it('lays out a ~300-node L3 view within the budget', async () => {
    const big = new GraphIndex(bigGraph(3, 10, 6));
    const view = computeView(big, 3);
    expect(view.nodes.length).toBeGreaterThan(250);
    const t0 = performance.now();
    const scene = await layoutView(view, elk, buildSeverity(big));
    const ms = performance.now() - t0;
    console.log(`L3 layout of ${view.nodes.length} nodes / ${view.edges.length} edges: ${ms.toFixed(0)} ms`);
    checkScene(scene, view.nodes.length);
    expect(ms).toBeLessThan(8000);
  });
});

/** accounts × networks × subnets, every network attached to one hub per account, one route table per subnet. */
function bigGraph(accounts: number, networks: number, subnets: number): NetworkGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const node = (id: string, kind: string, name: string, parentId?: string, attrs: Record<string, any> = {}): GraphNode =>
    ({ id, kind, provider: 'aws', nativeId: name, name, visibility: 'full', membership: 'blueprint', parentId, attrs } as GraphNode);
  let eid = 0;
  const edge = (from: string, kind: string, to: string) => edges.push({ id: `e${eid++}`, from, to, kind, attrs: {} });
  for (let a = 0; a < accounts; a++) {
    const acct = `aws:-:global:account:10000000000${a}`;
    nodes.push(node(acct, 'account', `acct-${a}`));
    const hub = `aws:-:us-east-1:hub:tgw-${a}`;
    nodes.push(node(hub, 'hub', `hub-${a}`, acct));
    for (let n = 0; n < networks; n++) {
      const vpc = `aws:-:us-east-1:network:vpc-${a}-${n}`;
      nodes.push(node(vpc, 'network', `net-${a}-${n}`, acct));
      const att = `aws:-:us-east-1:hub-attachment:tgw-attach-${a}-${n}`;
      nodes.push(node(att, 'hub-attachment', `att-${a}-${n}`, hub));
      edge(vpc, 'attaches', att);
      edge(att, 'attaches', hub);
      for (let s = 0; s < subnets; s++) {
        const sn = `aws:-:us-east-1:subnet:subnet-${a}-${n}-${s}`;
        nodes.push(node(sn, 'subnet', `sn-${a}-${n}-${s}`, vpc, { az: 'us-east-1a' }));
        const rt = `aws:-:us-east-1:route-table:rtb-${a}-${n}-${s}`;
        nodes.push(node(rt, 'route-table', `rt-${a}-${n}-${s}`, vpc));
        edge(sn, 'associated', rt);
        edge(rt, 'routes-to', hub);
      }
    }
  }
  return { schemaVersion: 1, nodes, edges, findings: [] };
}
