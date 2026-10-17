import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { relatedResources } from '../src/app/model/related';
import { hubFixture } from './fixture';

describe('relatedResources', () => {
  const idx = new GraphIndex(hubFixture().graph);

  it('lists what a network contains and what it is attached to', () => {
    const net = idx.graph.nodes.find(n => n.kind === 'network' && n.name === 'egress')!;
    const groups = relatedResources(idx, net);
    expect(groups.some(g => g.title.startsWith('Contains · Subnets'))).toBe(true);
    expect(groups.every(g => g.items.length > 0)).toBe(true);
  });

  it('names the owner of an interface instead of the interface', () => {
    const sg = idx.graph.nodes.find(n => n.kind === 'security-group' && idx.in(n.id, 'uses').length)!;
    const used = relatedResources(idx, sg).find(g => g.title.startsWith('Used by'))!;
    expect(used).toBeTruthy();
    for (const it of used.items) expect(idx.node(it.nodeId)).toBeTruthy();
  });

  it('gives every node a parent group except top-level ones', () => {
    const subnet = idx.graph.nodes.find(n => n.kind === 'subnet')!;
    expect(relatedResources(idx, subnet)[0].title).toMatch(/^Inside/);
  });
});
