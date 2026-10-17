import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { nodeDetails } from '../src/app/model/details';
import { hubFixture } from './fixture';
import { world } from './world';

describe('nodeDetails', () => {
  const idx = new GraphIndex(hubFixture().graph);

  it('lists a route table\'s routes most-specific first, with the implicit local route and its subnets', () => {
    const rt = idx.graph.nodes.find(n => n.kind === 'route-table' && idx.out(n.id, 'routes-to').length)!;
    const [routes, used] = nodeDetails(idx, rt);
    expect(routes.title).toBe('Routes');
    expect(routes.rows.some(r => r.cells[1] === 'local')).toBe(true);
    const lens = routes.rows.map(r => Number(/\/(\d+)/.exec(r.cells[0])?.[1] ?? -1));
    expect([...lens].sort((a, b) => b - a)).toEqual(lens);
    expect(routes.rows.filter(r => r.cells[1] !== 'local').every(r => r.nodeId || r.cells[1])).toBe(true);
    expect(used.title).toBe('Used by subnets');
  });

  it('shows security group inbound and outbound rules', () => {
    const w = world();
    const g = new GraphIndex(w.graph());
    const sg = g.graph.nodes.find(n => n.kind === 'security-group' && g.in(n.id, 'allows').length + g.out(n.id, 'allows').length > 0)!;
    const [inb, outb] = nodeDetails(g, sg);
    expect(inb.title).toBe('Inbound rules');
    expect(outb.title).toBe('Outbound rules');
    expect(inb.rows.length + outb.rows.length).toBeGreaterThan(0);
  });

  it('orders NACL entries by rule number and marks denies', () => {
    const w = world();
    const g = new GraphIndex(w.graph());
    const nacl = g.graph.nodes.find(n => n.kind === 'nacl' && (n.raw as any)?.Entries)!;
    const [inb] = nodeDetails(g, nacl);
    const nums = inb.rows.map(r => (r.cells[0] === '*' ? 32767 : Number(r.cells[0])));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(inb.rows.at(-1)!.cells[4]).toBe('deny');
    expect(inb.rows.at(-1)!.tone).toBe('bad');
  });

  it('returns nothing extra for kinds without detail tables', () => {
    expect(nodeDetails(idx, idx.graph.nodes.find(n => n.kind === 'network')!)).toEqual([]);
  });
});
