import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { buildSeverity, edgeSeverity, nodeSeverity } from '../src/app/model/severity';
import { computeView } from '../src/app/model/zoom';
import { hubFixture } from './fixture';

const idx = new GraphIndex(hubFixture().graph);
const ctx = buildSeverity(idx);

describe('severity', () => {
  it('rolls finding severity up to containers', () => {
    const sg = idx.byName('security-group', 'bastion')!;
    const egress = idx.byName('network', 'egress')!;
    expect(ctx.nodeSev.get(sg.id)).toBe('bad');
    expect(ctx.nodeSev.get(egress.id)).toBe('bad');
    expect(ctx.nodeSev.get('aws:-:global:account:111111111111')).toBe('bad');
    expect(ctx.nodeSev.get(idx.byName('vpn-connection', 'Site E 2')!.id)).toBe('warn');
    expect(ctx.nodeSev.has(idx.byName('network', 'prod-ue1')!.id)).toBe(false);
  });

  it('finds the egress chokepoint', () => {
    expect([...ctx.chokepoints]).toEqual([idx.byName('network', 'egress')!.id]);
  });

  it('colours L1 edges', () => {
    const v = computeView(idx, 1);
    const nodes = new Map(v.nodes.map(n => [n.id, n]));
    const egress = idx.byName('network', 'egress')!.id;
    const prod = idx.byName('network', 'prod-ue1')!.id;
    const hub = idx.byName('hub', 'hub-egress-tgw')!.id;

    const internetEdge = v.edges.find(e => e.to === egress && nodes.get(e.from)?.label === 'Internet')!;
    expect(edgeSeverity(internetEdge, nodes, ctx)).toBe('bad');
    expect(edgeSeverity(v.edges.find(e => e.from === prod && e.to === hub)!, nodes, ctx)).toBe('ok');
    const degradedAgg = v.nodes.find(n => n.aggregate && n.aggregate.degraded > 0)!;
    expect(edgeSeverity(v.edges.find(e => e.from === degradedAgg.id)!, nodes, ctx)).toBe('warn');
    const stubEdge = v.edges.find(e => nodes.get(e.to)?.visibility === 'stub' && e.from === hub)!;
    expect(edgeSeverity(stubEdge, nodes, ctx)).toBe('stub');
    expect(nodeSeverity(degradedAgg, ctx)).toBe('warn');
  });
});
