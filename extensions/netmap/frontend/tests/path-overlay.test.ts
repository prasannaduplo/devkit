import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GraphIndex } from '../src/app/model/graph-index';
import { ElkLike, layoutView } from '../src/app/model/layout';
import { INTERNET_ID, tracePath } from '../src/app/model/path';
import { pathLevel, pathOverlay } from '../src/app/model/path-overlay';
import { buildSeverity } from '../src/app/model/severity';
import { computeView } from '../src/app/model/zoom';
import { hubFixture } from './fixture';

const elk = new ELK() as unknown as ElkLike;

describe('path overlay', () => {
  const idx = new GraphIndex(hubFixture().graph);
  const path = tracePath(idx, { from: idx.byName('subnet', 'app-1a')!.id, direction: 'outbound' });

  it('picks the unfocused level that draws the most hops (L3 here)', () => {
    expect(pathLevel(idx, path)).toBe(3);
  });

  it('maps hops to drawn boxes, keeps their containers bright and fits to them', async () => {
    const scene = await layoutView(computeView(idx, 3), elk, buildSeverity(idx));
    const o = pathOverlay(idx, scene, path);
    const ids = o.stops.map(s => s.boxId);
    expect(ids[0]).toBe('aws:-:us-east-1:subnet:subnet-prod-app-1a');
    expect(ids[ids.length - 1]).toBe(INTERNET_ID);
    expect(ids).toContain('aws:-:us-east-1:nat-gateway:nat-egress-1a');
    // consecutive hops on one box collapse into one numbered stop
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
    expect(o.stops[0].hops.length).toBeGreaterThan(1);
    expect(o.stops[0].label).toMatch(/^1–\d+$/);
    expect(o.stops[0].sev).toBe('warn'); // SG / NACL not evaluated on the first stop
    expect(o.segments).toHaveLength(o.stops.length - 1);
    expect(o.keep.has('aws:-:us-east-1:network:vpc-prod')).toBe(true);
    expect(o.keep.has('aws:-:us-east-1:network:vpc-shared-services')).toBe(false);
    expect(o.bounds!.w).toBeGreaterThan(0);
    // every hop number appears exactly once
    expect(o.stops.flatMap(s => s.hops)).toEqual(path.hops.map((_, i) => i + 1).filter(n => o.stops.some(s => s.hops.includes(n))));
  });

  it('an empty path overlays nothing', async () => {
    const scene = await layoutView(computeView(idx, 1), elk, buildSeverity(idx));
    const o = pathOverlay(idx, scene, { outcome: 'unknown', hops: [], summary: '' });
    expect(o.stops).toEqual([]);
    expect(o.bounds).toBeNull();
  });
});
