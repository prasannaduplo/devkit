import { describe, expect, it } from 'vitest';
import { GraphIndex, num, str, strs } from '../src/app/model/graph-index';
import { cidrsOverlap, parseV4 } from '../src/app/model/cidr';
import { hubFixture } from './fixture';

describe('GraphIndex', () => {
  const idx = new GraphIndex(hubFixture().graph);

  it('looks up nodes, children, ancestors and edges', () => {
    const egress = idx.byName('network', 'egress')!;
    expect(egress).toBeDefined();
    const subnets = idx.children(egress.id).filter(n => n.kind === 'subnet');
    expect(subnets).toHaveLength(4);
    const nat = idx.ofKind('nat-gateway')[0];
    expect(idx.ancestorOfKind(nat.id, 'network')?.id).toBe(egress.id);
    expect(idx.isAncestor(egress.id, nat.id)).toBe(true);
    expect(idx.isAncestor(nat.id, egress.id)).toBe(false);
    expect(idx.out(egress.id, 'attaches').length).toBeGreaterThan(0);
    expect(idx.in(idx.ofKind('internet-gateway')[0].id).length).toBeGreaterThan(0);
  });

  it('reads attrs safely', () => {
    expect(str('a')).toBe('a');
    expect(str(3)).toBeUndefined();
    expect(num(3)).toBe(3);
    expect(num('3')).toBeUndefined();
    expect(strs(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(strs(undefined)).toEqual([]);
  });
});

describe('cidr', () => {
  it('parses and detects overlap', () => {
    expect(parseV4('10.0.0.0/16')).toEqual([167772160, 167837695]);
    expect(parseV4('nope')).toBeNull();
    expect(cidrsOverlap('10.0.0.0/16', '10.0.255.0/24')).toBe(true);
    expect(cidrsOverlap('10.0.0.0/16', '10.1.0.0/16')).toBe(false);
    expect(cidrsOverlap('0.0.0.0/0', '192.0.2.0/24')).toBe(true);
    expect(cidrsOverlap('2001:db8::/32', '10.0.0.0/8')).toBe(false);
  });
});
