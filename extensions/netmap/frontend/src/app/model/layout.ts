import { str } from './graph-index';
import { kindInfo } from './kinds';
import { Sev, SeverityContext, edgeSeverity, nodeSeverity } from './severity';
import { ViewModel, ViewNode } from './zoom';

export interface Point { x: number; y: number }
export interface ElkSection { startPoint: Point; endPoint: Point; bendPoints?: Point[] }
export interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
}
export interface ElkEdge { id: string; sources: string[]; targets: string[]; sections?: ElkSection[]; container?: string }
export interface ElkLike { layout(graph: ElkNode): Promise<ElkNode> }

export interface SceneBox {
  id: string;
  x: number; y: number; w: number; h: number;
  /** Text/icon anchors relative to the box origin. */
  ix: number; iy: number; lx: number; ly: number; sy: number;
  kind: string;
  label: string;
  sublabel?: string;
  container: boolean;
  depth: number;
  visibility: string;
  severity: Sev;
  chokepoint: boolean;
  boundary: boolean;
  icon: string;
  variant?: string;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  d: string;
  points: Point[];
  mid: Point;
  severity: Sev;
  count: number;
  kinds: string[];
  edgeIds: string[];
}

export interface Scene { width: number; height: number; boxes: SceneBox[]; edges: SceneEdge[] }

export const LEAF_W = 184;
export const LEAF_H = 52;
export const HEADER = 34;
export const PAD = 14;
export const EMPTY_SCENE: Scene = { width: 0, height: 0, boxes: [], edges: [] };

const ROOT = '__root';
const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '22',
  'elk.spacing.edgeNode': '14',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.padding': '[top=20,left=20,bottom=20,right=20]',
};
const CONTAINER_OPTIONS: Record<string, string> = { 'elk.padding': `[top=${HEADER},left=${PAD},bottom=${PAD},right=${PAD}]` };

export function toElk(view: ViewModel): ElkNode {
  const ids = new Set(view.nodes.map(n => n.id));
  const byParent = new Map<string, ViewNode[]>();
  for (const n of view.nodes) {
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : ROOT;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(n);
  }
  const build = (n: ViewNode): ElkNode => {
    const kids = byParent.get(n.id);
    if (!kids?.length) return { id: n.id, width: LEAF_W, height: LEAF_H };
    return { id: n.id, layoutOptions: { ...CONTAINER_OPTIONS }, children: kids.map(build) };
  };
  return {
    id: ROOT,
    layoutOptions: { ...ROOT_OPTIONS },
    children: (byParent.get(ROOT) ?? []).map(build),
    edges: view.edges.map(e => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
}

export async function layoutView(view: ViewModel, elk: ElkLike, ctx: SeverityContext): Promise<Scene> {
  if (view.needsFocus || view.nodes.length === 0) return EMPTY_SCENE;
  return toScene(view, await elk.layout(toElk(view)), ctx);
}

/** ELK output → absolute scene. Edge sections are in the frame of `edge.container` when ELK sets it, else
 * the root (the rule proven by tests/elk-smoke.test.ts — keep them in sync). */
export function toScene(view: ViewModel, laid: ElkNode, ctx: SeverityContext): Scene {
  const viewNodes = new Map(view.nodes.map(n => [n.id, n]));
  const abs = new Map<string, Point>();
  const boxes: SceneBox[] = [];

  const walk = (n: ElkNode, ox: number, oy: number, depth: number): void => {
    const x = ox + (n.x ?? 0);
    const y = oy + (n.y ?? 0);
    abs.set(n.id, { x, y });
    const v = viewNodes.get(n.id);
    if (v) {
      const w = n.width ?? LEAF_W;
      const h = n.height ?? LEAF_H;
      const container = !!n.children?.length;
      const hasSub = !!v.sublabel;
      boxes.push({
        id: v.id, x, y, w, h,
        ix: 10, iy: container ? 9 : h / 2 - 8,
        lx: container ? 32 : 34,
        ly: container ? 17 : hasSub ? h / 2 - 2 : h / 2 + 4,
        sy: container ? 28 : h / 2 + 11,
        kind: v.kind,
        label: fit(v.label, w - 44, 6.6),
        sublabel: v.sublabel ? fit(v.sublabel, w - 44, 5.7) : undefined,
        container,
        depth,
        visibility: v.visibility,
        severity: nodeSeverity(v, ctx),
        chokepoint: ctx.chokepoints.has(v.id),
        boundary: !!v.boundary,
        icon: iconFor(v),
        variant: variantOf(v),
      });
    }
    for (const c of n.children ?? []) walk(c, x, y, v ? depth + 1 : depth);
  };
  walk(laid, 0, 0, 0);

  const viewEdges = new Map(view.edges.map(e => [e.id, e]));
  const edges: SceneEdge[] = [];
  for (const e of laid.edges ?? []) {
    const ve = viewEdges.get(e.id);
    if (!ve) continue;
    const frame = (e.container && abs.get(e.container)) || { x: 0, y: 0 };
    const points: Point[] = [];
    for (const s of e.sections ?? []) {
      for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) points.push({ x: frame.x + p.x, y: frame.y + p.y });
    }
    if (points.length < 2) continue;
    edges.push({
      id: ve.id, from: ve.from, to: ve.to,
      points,
      d: points.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`).join(' '),
      mid: points[Math.floor(points.length / 2)],
      severity: edgeSeverity(ve, viewNodes, ctx),
      count: ve.count,
      kinds: ve.kinds,
      edgeIds: ve.edgeIds,
    });
  }

  boxes.sort((a, b) => Number(b.container) - Number(a.container) || a.depth - b.depth);
  return { width: laid.width ?? 0, height: laid.height ?? 0, boxes, edges };
}

export function iconFor(v: ViewNode): string {
  if (v.aggregate) return v.kind === 'pod' ? 'pod' : 'site';
  if (v.kind === 'external' && str(v.source?.attrs?.['role']) === 'internet') return 'internet';
  return kindInfo(v.kind).icon;
}

function variantOf(v: ViewNode): string | undefined {
  if (v.kind !== 'subnet') return undefined;
  return v.source?.attrs?.['isPublic'] === true ? 'public' : 'private';
}

export function fit(text: string, px: number, charWidth: number): string {
  const max = Math.max(4, Math.floor(px / charWidth));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
