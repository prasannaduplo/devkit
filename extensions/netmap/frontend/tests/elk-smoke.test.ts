import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';

// Spike: nested containers + an edge between nodes in different containers, laid out with INCLUDE_CHILDREN.
describe('elkjs smoke', () => {
  it('lays out a hierarchical graph and reports the edge coordinate frame', async () => {
    const elk = new ELK();
    const out: any = await elk.layout({
      id: 'root',
      layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.edgeRouting': 'ORTHOGONAL' },
      children: [
        { id: 'acctA', layoutOptions: { 'elk.padding': '[top=34,left=14,bottom=14,right=14]' }, children: [{ id: 'a1', width: 184, height: 52 }] },
        { id: 'acctB', layoutOptions: { 'elk.padding': '[top=34,left=14,bottom=14,right=14]' }, children: [{ id: 'b1', width: 184, height: 52 }] },
      ],
      edges: [{ id: 'e1', sources: ['a1'], targets: ['b1'] }],
    });

    const abs = new Map<string, { x: number; y: number; w: number; h: number }>();
    const walk = (n: any, ox: number, oy: number) => {
      const x = ox + (n.x ?? 0), y = oy + (n.y ?? 0);
      abs.set(n.id, { x, y, w: n.width ?? 0, h: n.height ?? 0 });
      for (const c of n.children ?? []) walk(c, x, y);
    };
    walk(out, 0, 0);

    const e = out.edges[0];
    const start = e.sections[0].startPoint;
    const frame = e.container ? abs.get(e.container)! : { x: 0, y: 0 };
    const s = { x: frame.x + start.x, y: frame.y + start.y };
    const a1 = abs.get('a1')!;
    // The start point must lie on a1's border once offset by the edge's container frame.
    expect(s.x).toBeGreaterThanOrEqual(a1.x - 0.5);
    expect(s.x).toBeLessThanOrEqual(a1.x + a1.w + 0.5);
    expect(s.y).toBeGreaterThanOrEqual(a1.y - 0.5);
    expect(s.y).toBeLessThanOrEqual(a1.y + a1.h + 0.5);
    console.log('ELK edge container property:', e.container ?? '(none — root frame)');
  });
});
