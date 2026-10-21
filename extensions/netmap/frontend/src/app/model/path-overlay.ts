import { GraphIndex } from './graph-index';
import { Point, Scene, SceneBox } from './layout';
import { Hop, PathResult, Verdict } from './path';
import { Sev } from './severity';
import { Level, computeView } from './zoom';

// Placing a traced path on the drawn map: which level shows it best, which drawn box stands for each hop (the
// node itself or its nearest drawn ancestor — the same fallback the map's centreOn uses), and the overlay geometry.
// Framework-free.

export const VERDICT_SEV: Record<Verdict, Sev> = { allow: 'ok', info: 'ok', unknown: 'warn', block: 'bad' };
const SEV_RANK: Record<string, number> = { ok: 0, warn: 1, bad: 2 };

/** The unfocused level (1–3) that draws the most distinct hops; ties go to the more detailed level. */
export function pathLevel(idx: GraphIndex, path: PathResult): Level {
  let best: Level = 3;
  let bestCount = -1;
  for (const level of [3, 2, 1] as Level[]) {
    const visible = new Set(computeView(idx, level).nodes.map(n => n.id));
    const reps = new Set(path.hops.map(h => repOf(idx, h.nodeId, visible)).filter(Boolean));
    if (reps.size > bestCount) { best = level; bestCount = reps.size; }
  }
  return best;
}

function repOf(idx: GraphIndex, id: string, drawn: Set<string>): string | undefined {
  if (drawn.has(id)) return id;
  return idx.ancestors(id).find(a => drawn.has(a.id))?.id;
}

export interface OverlayStop { boxId: string; at: Point; badge: Point; label: string; sev: Sev; hops: number[] }
export interface OverlaySegment { d: string; sev: Sev }
export interface PathOverlay {
  stops: OverlayStop[];
  segments: OverlaySegment[];
  /** Boxes that stay bright: the stops and every container around them. */
  keep: Set<string>;
  /** Scene edges between consecutive stops. */
  keepEdges: Set<string>;
  bounds: { x: number; y: number; w: number; h: number } | null;
}

export function pathOverlay(idx: GraphIndex, scene: Scene, path: PathResult): PathOverlay {
  const boxes = new Map(scene.boxes.map(b => [b.id, b]));
  const drawn = new Set(boxes.keys());
  const stops: OverlayStop[] = [];
  path.hops.forEach((h: Hop, i: number) => {
    const rep = repOf(idx, h.nodeId, drawn);
    if (!rep) return;
    const sev = VERDICT_SEV[h.verdict];
    const last = stops[stops.length - 1];
    if (last && last.boxId === rep) {
      last.hops.push(i + 1);
      if (SEV_RANK[sev] > SEV_RANK[last.sev]) last.sev = sev;
      return;
    }
    const b = boxes.get(rep)!;
    stops.push({ boxId: rep, at: anchor(b), badge: { x: b.x + 2, y: b.y + 2 }, label: '', sev, hops: [i + 1] });
  });
  for (const s of stops) s.label = s.hops.length > 1 ? `${s.hops[0]}–${s.hops[s.hops.length - 1]}` : String(s.hops[0]);

  const segments: OverlaySegment[] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1].at;
    const b = stops[i].at;
    // a gentle curve so a path that doubles back stays readable
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - Math.min(40, Math.hypot(b.x - a.x, b.y - a.y) / 6);
    segments.push({ d: `M${r(a.x)} ${r(a.y)} Q${r(mx)} ${r(my)} ${r(b.x)} ${r(b.y)}`, sev: stops[i].sev });
  }

  const keep = new Set<string>();
  for (const s of stops) {
    keep.add(s.boxId);
    for (const a of idx.ancestors(s.boxId)) if (drawn.has(a.id)) keep.add(a.id);
  }
  const pairs = new Set<string>();
  for (let i = 1; i < stops.length; i++) {
    pairs.add(`${stops[i - 1].boxId}>${stops[i].boxId}`);
    pairs.add(`${stops[i].boxId}>${stops[i - 1].boxId}`);
  }
  const keepEdges = new Set(scene.edges.filter(e => pairs.has(`${e.from}>${e.to}`)).map(e => e.id));

  let bounds: PathOverlay['bounds'] = null;
  // containers count with their header strip only: a whole network frame would zoom the fit out to nothing
  const rects = stops.map(s => boxes.get(s.boxId)!).map(b => (b.container ? { x: b.x, y: b.y, w: Math.min(b.w, 240), h: 34 } : b));
  if (rects.length) {
    const x0 = Math.min(...rects.map(b => b.x));
    const y0 = Math.min(...rects.map(b => b.y));
    const x1 = Math.max(...rects.map(b => b.x + b.w));
    const y1 = Math.max(...rects.map(b => b.y + b.h));
    bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return { stops, segments, keep, keepEdges, bounds };
}

/** Leaf cards: their centre. Containers: the middle of the header strip, so the line does not cross children. */
function anchor(b: SceneBox): Point {
  return b.container ? { x: b.x + Math.min(b.w / 2, 120), y: b.y + 17 } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function r(v: number): number {
  return Math.round(v * 10) / 10;
}
