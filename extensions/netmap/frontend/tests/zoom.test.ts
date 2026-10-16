import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { kindInfo } from '../src/app/model/kinds';
import { computeView, ViewModel } from '../src/app/model/zoom';
import { hubFixture } from './fixture';

const idx = new GraphIndex(hubFixture().graph);

function invariants(v: ViewModel): void {
  const ids = new Set(v.nodes.map(n => n.id));
  expect(ids.size).toBe(v.nodes.length);
  for (const n of v.nodes) if (n.parentId) expect(ids.has(n.parentId)).toBe(true);
  for (const e of v.edges) {
    expect(ids.has(e.from)).toBe(true);
    expect(ids.has(e.to)).toBe(true);
    expect(e.from).not.toBe(e.to);
    expect(idx.isAncestor(e.from, e.to) || idx.isAncestor(e.to, e.from)).toBe(false);
  }
}

describe('computeView', () => {
  it('L1 shows accounts, networks, hubs and externals, with VPN sites aggregated per hub', () => {
    const v = computeView(idx, 1);
    invariants(v);
    expect(v.needsFocus).toBe(false);
    for (const n of v.nodes) if (!n.aggregate) expect(kindInfo(n.kind).level).toBe(1);
    expect(v.nodes.some(n => n.kind === 'subnet')).toBe(false);

    const aggs = v.nodes.filter(n => n.aggregate);
    expect(aggs.map(a => a.aggregate!.count).sort()).toEqual([2, 4, 4]);
    expect(aggs.filter(a => a.aggregate!.degraded > 0)).toHaveLength(1);
    expect(aggs.every(a => /VPN sites?$/.test(a.label))).toBe(true);
    for (const a of aggs) expect(v.edges.some(e => e.from === a.id && v.nodes.find(n => n.id === e.to)?.kind === 'hub')).toBe(true);

    const egress = idx.byName('network', 'egress')!;
    expect(v.nodes.find(n => n.id === egress.id)?.parentId).toBe('aws:-:global:account:111111111111');
    const hub = idx.byName('hub', 'hub-egress-tgw')!;
    expect(v.edges.some(e => e.from === egress.id && e.to === hub.id)).toBe(true);
  });

  it('L2 shows each VPN connection, customer gateway and gateway — no aggregates', () => {
    const v = computeView(idx, 2);
    invariants(v);
    expect(v.nodes.filter(n => n.aggregate)).toHaveLength(0);
    expect(v.nodes.filter(n => n.kind === 'vpn-connection')).toHaveLength(10);
    expect(v.nodes.filter(n => n.kind === 'peer-gateway')).toHaveLength(10);
    expect(v.nodes.filter(n => n.kind === 'nat-gateway')).toHaveLength(2);
    expect(v.nodes.filter(n => n.kind === 'internet-gateway')).toHaveLength(1);
  });

  it('L3 adds subnets and route tables', () => {
    const v = computeView(idx, 3);
    invariants(v);
    expect(v.nodes.filter(n => n.kind === 'subnet')).toHaveLength(5);
    expect(v.nodes.some(n => n.kind === 'route-table')).toBe(true);
  });

  it('L4 needs a network focus, then draws one network plus boundary nodes', () => {
    expect(computeView(idx, 4).needsFocus).toBe(true);
    const egress = idx.byName('network', 'egress')!;
    const v = computeView(idx, 4, egress.id);
    invariants(v);
    expect(v.needsFocus).toBe(false);
    for (const n of v.nodes.filter(x => !x.boundary)) expect(n.id === egress.id || idx.isAncestor(egress.id, n.id)).toBe(true);
    const boundary = v.nodes.filter(n => n.boundary).map(n => n.label);
    expect(boundary).toContain('hub-egress-tgw');
    expect(boundary).toContain('Internet');
    expect(v.nodes.find(n => n.id === egress.id)?.parentId).toBeUndefined();
    expect(v.nodes.some(n => n.kind === 'security-group')).toBe(true);
  });

  it('labels carry useful sublabels', () => {
    const v = computeView(idx, 3);
    const subnet = v.nodes.find(n => n.kind === 'subnet')!;
    expect(subnet.sublabel).toMatch(/\/\d+ · us-east-1[ab]/);
    const net = v.nodes.find(n => n.kind === 'network' && n.label === 'egress')!;
    expect(net.sublabel).toContain('/16');
  });
});
