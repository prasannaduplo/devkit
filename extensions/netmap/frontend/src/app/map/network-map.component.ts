import {
  Component, DestroyRef, ElementRef, NgZone, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { NetworkGraph } from '../model/api-types';
import { GraphIndex } from '../model/graph-index';
import { iconHref } from '../model/icons';
import { EMPTY_SCENE, Scene, SceneBox, SceneEdge } from '../model/layout';
import { MAP_CSS } from '../model/map-styles';
import { PathResult } from '../model/path';
import { pathLevel, pathOverlay } from '../model/path-overlay';
import { boxClasses, edgeClasses } from '../model/scene-svg';
import { buildSeverity } from '../model/severity';
import { Level, computeView } from '../model/zoom';
import { kindInfo } from '../model/kinds';
import { ElkLayoutService } from './elk-layout.service';

export type MapSelection =
  | { kind: 'node'; id: string }
  | { kind: 'aggregate'; id: string; label: string; memberIds: string[] }
  | { kind: 'edge'; id: string; from: string; to: string; kinds: string[]; count: number; edgeIds: string[] };

const LEVELS: { level: Level; label: string; hint: string }[] = [
  { level: 1, label: 'L1', hint: 'Very high — accounts, networks, hubs, outside world' },
  { level: 2, label: 'L2', hint: 'High — gateways, VPNs, NAT / IGW' },
  { level: 3, label: 'L3', hint: 'Mid — subnets, route tables, load balancers, endpoints' },
  { level: 4, label: 'L4', hint: 'Low — interfaces, workloads, security groups (one network)' },
];

@Component({
  selector: 'nm-network-map',
  styles: [MAP_CSS, `
    :host { display: block; }
    .nm-map { position: relative; border: 1px solid var(--nm-line); border-radius: 12px; overflow: hidden; background: var(--nm-bg); }
    .nm-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid var(--nm-line); background: var(--nm-surface); }
    .nm-levels, .nm-zoom { display: inline-flex; gap: 2px; background: var(--nm-surface-2); border-radius: 8px; padding: 2px; }
    .nm-levels button, .nm-zoom button { border: 0; background: none; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 12px; color: var(--nm-ink-soft); cursor: pointer; }
    .nm-levels button.active { background: var(--nm-surface); color: var(--nm-accent); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .nm-levels button:disabled { opacity: .4; cursor: not-allowed; }
    .nm-zoom span { font-size: 11px; padding: 4px 6px; color: var(--nm-faint); font-variant-numeric: tabular-nums; }
    .nm-crumbs { font-size: 13px; color: var(--nm-faint); flex: 1 1 auto; }
    .nm-crumbs a { color: var(--nm-accent); cursor: pointer; }
    .nm-crumbs span { margin: 0 6px; }
    .nm-stage { position: relative; height: 620px; cursor: grab; touch-action: none; }
    .nm-stage.dragging { cursor: grabbing; }
    .nm-hint { position: absolute; top: 16px; left: 16px; right: 16px; z-index: 2; background: var(--nm-surface); border: 1px solid var(--nm-line); border-radius: 8px; padding: 8px 12px; font-size: 12.5px; color: var(--nm-ink-soft); }
    .nm-legend { position: absolute; right: 12px; bottom: 12px; z-index: 2; background: var(--nm-surface); border: 1px solid var(--nm-line); border-radius: 10px; padding: 8px 12px; display: flex; gap: 10px 14px; flex-wrap: wrap; max-width: 520px; font: 11px ui-monospace, monospace; color: var(--nm-ink-soft); }
    .nm-legend i { display: inline-block; width: 22px; height: 0; border-top: 2px dashed; vertical-align: middle; margin-right: 5px; }
    .nm-chip-f { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; padding: 2px 4px 2px 10px; border-radius: 1rem; background: var(--nm-surface-2); color: var(--nm-ink-soft); max-width: 280px; }
    .nm-chip-f span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nm-chip-f b { color: var(--nm-ink); font-weight: 600; }
    .nm-chip-f button { border: 0; background: none; color: var(--nm-faint); cursor: pointer; padding: 0 6px; font-size: 12px; line-height: 1; }
    .nm-chip-f button:hover { color: var(--nm-ink); }
    .nm-chip-f.path { background: var(--nm-choke-bg); }
    .nm-legend b { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: middle; margin-right: 5px; border: 1px solid; }
  `],
  template: `
    <div class="nm-root nm-map">
      <div class="nm-toolbar">
        <div class="nm-levels" role="group" aria-label="Zoom level">
          @for (l of levels; track l.level) {
            <button type="button" [class.active]="level() === l.level" [disabled]="l.level === 4 && !canL4()" [title]="l.hint" (click)="setLevel(l.level)">{{ l.label }}</button>
          }
        </div>
        <nav class="nm-crumbs">
          <a (click)="setFocus(undefined)">Whole blueprint</a>
          @for (c of crumbs(); track c.id) { <span>›</span><a (click)="setFocus(c.id)">{{ c.name }}</a> }
        </nav>
        @if (focusName(); as f) {
          <span class="nm-chip-f" [title]="'Focused on ' + f"><span>Focused on <b>{{ f }}</b></span><button type="button" title="Clear focus" aria-label="Clear focus" (click)="setFocus(undefined)">✕</button></span>
        }
        @if (overlay(); as o) {
          <span class="nm-chip-f path"><span>Path · {{ path()!.hops.length }} hops</span><button type="button" title="Clear the path" aria-label="Clear the path" (click)="clearPath.emit()">✕</button></span>
        }
        <div class="nm-zoom">
          <button type="button" title="Zoom out" (click)="zoomBy(0.85)">−</button>
          <span>{{ zoomPct() }}%</span>
          <button type="button" title="Zoom in" (click)="zoomBy(1.18)">+</button>
          <button type="button" title="Fit to screen" (click)="fit()">⤢</button>
        </div>
      </div>

      <!-- pan/zoom listeners are registered outside NgZone in the constructor (see bindGestures) -->
      <div #stage class="nm-stage">
        @if (needsFocus()) {
          <div class="nm-hint">Level 4 draws one network at a time — double-click a network on L1–L3, or choose it in the breadcrumb.</div>
        } @else if (busy() && !scene().boxes.length) {
          <div class="nm-hint">Laying out the network…</div>
        }
        @if (error()) { <div class="nm-hint text-danger">Layout failed: {{ error() }}</div> }

        <svg #canvas class="nm-canvas" [class.nm-calm]="calm()" (click)="clearSelection()">
          <g #world>
            @for (x of containers(); track x.b.id) {
              <g [attr.class]="x.cls" [attr.transform]="x.t" (click)="pickBox($event, x.b)" (dblclick)="drill($event, x.b)">
                <rect class="nm-frame" [attr.width]="x.b.w" [attr.height]="x.b.h" rx="8" />
                <use class="nm-icon" [attr.href]="x.href" [attr.x]="x.b.ix" [attr.y]="x.b.iy" width="16" height="16" />
                <text class="nm-label" [attr.x]="x.b.lx" [attr.y]="x.b.ly">{{ x.b.label }}</text>
                @if (x.b.sublabel) { <text class="nm-sub" [attr.x]="x.b.lx" [attr.y]="x.b.sy">{{ x.b.sublabel }}</text> }
              </g>
            }
            @for (x of edges(); track x.e.id) {
              <path [attr.class]="x.cls" [attr.d]="x.e.d" />
              <path class="nm-hit" [attr.d]="x.e.d" (click)="pickEdge($event, x.e)" />
              @if (x.e.count > 1) { <text class="nm-count" [attr.x]="x.e.mid.x" [attr.y]="x.e.mid.y - 4" text-anchor="middle">{{ x.e.count }}×</text> }
            }
            @for (x of leaves(); track x.b.id) {
              <g [attr.class]="x.cls" [attr.transform]="x.t" (click)="pickBox($event, x.b)" (dblclick)="drill($event, x.b)">
                <rect class="nm-frame" [attr.width]="x.b.w" [attr.height]="x.b.h" rx="8" />
                <use class="nm-icon" [attr.href]="x.href" [attr.x]="x.b.ix" [attr.y]="x.b.iy" width="16" height="16" />
                <text class="nm-label" [attr.x]="x.b.lx" [attr.y]="x.b.ly">{{ x.b.label }}</text>
                @if (x.b.sublabel) { <text class="nm-sub" [attr.x]="x.b.lx" [attr.y]="x.b.sy">{{ x.b.sublabel }}</text> }
              </g>
            }
            @if (overlay(); as o) {
              <g class="nm-trace-layer">
                @for (s of o.segments; track $index) {
                  <path class="nm-trace-under" [attr.d]="s.d" />
                  <path [attr.class]="'nm-trace sev-' + s.sev" [attr.d]="s.d" />
                }
                @for (s of o.stops; track $index) {
                  @let bw = 12 + s.label.length * 6.4;
                  <g [attr.class]="'nm-badge sev-' + s.sev" [attr.transform]="'translate(' + s.badge.x + ',' + s.badge.y + ')'">
                    <rect [attr.x]="-bw / 2" y="-9" [attr.width]="bw" height="18" rx="9" />
                    <text text-anchor="middle" y="3.5">{{ s.label }}</text>
                  </g>
                }
              </g>
            }
          </g>
        </svg>

        <div class="nm-legend">
          <span><i style="border-color: var(--nm-ok)"></i>allowed / healthy</span>
          <span><i style="border-color: var(--nm-warn)"></i>warning</span>
          <span><i style="border-color: var(--nm-bad)"></i>critical</span>
          <span><i style="border-color: var(--nm-stub)"></i>outside / not visible</span>
          <span><b style="background: var(--nm-choke-bg); border-color: var(--nm-choke)"></b>egress chokepoint</span>
          <span><b style="background: var(--nm-public-fill); border-color: var(--nm-public-line)"></b>public subnet</span>
          <span><b style="background: var(--nm-private-fill); border-color: var(--nm-private-line)"></b>private subnet</span>
          <span>double-click to open · drag to pan · scroll to zoom</span>
        </div>
      </div>
    </div>
  `,
})
export class NetworkMapComponent {
  private readonly elk = inject(ElkLayoutService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private readonly stage = viewChild<ElementRef<HTMLDivElement>>('stage');
  private readonly canvas = viewChild<ElementRef<SVGSVGElement>>('canvas');
  private readonly world = viewChild<ElementRef<SVGGElement>>('world');

  readonly graph = input<NetworkGraph | null>(null);
  /** Bring a node into view: picks the level and focus that draw it, selects it and centres on it. `seq` re-triggers the same id. */
  readonly reveal = input<{ id: string; seq: number } | null>(null);
  /** A traced path to draw over the map: everything else is dimmed, the hops are numbered. null = normal view. */
  readonly path = input<PathResult | null>(null);
  readonly selected = output<MapSelection | null>();
  readonly clearPath = output<void>();

  protected readonly levels = LEVELS;
  protected readonly level = signal<Level>(1);
  protected readonly focusId = signal<string | undefined>(undefined);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly scene = signal<Scene>(EMPTY_SCENE);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  // The view transform lives in plain fields and is written straight to the <g #world> transform attribute: the
  // portal host runs zone-based change detection over ~900 eager components, so pan/zoom must not go through
  // NgZone or signals per pointer/wheel event. Only the zoom % label is a signal, synced when a gesture ends.
  private k = 1;
  private tx = 0;
  private ty = 0;
  protected readonly zoomPct = signal(100);
  private runId = 0;
  /** Laid-out scenes by level|focus for the current graph: revisiting a level is instant. */
  private sceneCache = new Map<string, Scene>();
  private cacheFor?: unknown;
  private movingTimer?: ReturnType<typeof setTimeout>;
  private wheelTimer?: ReturnType<typeof setTimeout>;
  protected readonly calm = computed(() => this.scene().edges.length > 40);
  private drag?: { x: number; y: number; tx: number; ty: number };
  private dragging = false;
  private suppressClick = false;
  private pendingReveal?: string;
  private pendingPathFit = false;

  private readonly idx = computed(() => (this.graph() ? new GraphIndex(this.graph()!) : null));
  private readonly severity = computed(() => (this.idx() ? buildSeverity(this.idx()!) : null));
  private readonly view = computed(() => (this.idx() ? computeView(this.idx()!, this.level(), this.focusId()) : null));
  protected readonly needsFocus = computed(() => !!this.view()?.needsFocus);

  protected readonly canL4 = computed(() => {
    const idx = this.idx();
    const f = this.focusId();
    if (!idx || !f) return false;
    const n = idx.node(f);
    return !!n && (n.kind === 'network' || !!idx.ancestorOfKind(f, 'network'));
  });

  protected readonly crumbs = computed(() => {
    const idx = this.idx();
    const f = this.focusId();
    if (!idx || !f) return [];
    const n = idx.node(f);
    if (!n) return [];
    return [...idx.ancestors(f).reverse(), n].map(x => ({ id: x.id, name: x.name || x.nativeId }));
  });

  protected readonly focusName = computed(() => {
    const f = this.focusId();
    const n = f ? this.idx()?.node(f) : undefined;
    return n ? n.name || n.nativeId : '';
  });

  protected readonly overlay = computed(() => {
    const p = this.path();
    const idx = this.idx();
    const scene = this.scene();
    if (!p || !idx || !p.hops.length || !scene.boxes.length) return null;
    return pathOverlay(idx, scene, p);
  });

  private decorate(b: SceneBox, keep: Set<string> | null) {
    const cls = boxClasses(b, this.selectedId()) + (keep && !keep.has(b.id) ? ' nm-dim' : '');
    return { b, cls, t: `translate(${b.x},${b.y})`, href: iconHref(b.icon) };
  }

  protected readonly containers = computed(() => {
    const keep = this.overlay()?.keep ?? null;
    return this.scene().boxes.filter(b => b.container).map(b => this.decorate(b, keep));
  });
  protected readonly leaves = computed(() => {
    const keep = this.overlay()?.keep ?? null;
    return this.scene().boxes.filter(b => !b.container).map(b => this.decorate(b, keep));
  });
  protected readonly edges = computed(() => {
    const keep = this.overlay()?.keepEdges ?? null;
    return this.scene().edges.map(e => ({ e, cls: edgeClasses(e, this.selectedId()) + (keep && !keep.has(e.id) ? ' nm-dim' : '') }));
  });

  constructor() {
    afterNextRender(() => this.bindGestures());
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.movingTimer);
      clearTimeout(this.wheelTimer);
    });
    effect(() => {
      const view = this.view();
      const ctx = this.severity();
      if (!view || !ctx) {
        this.scene.set(EMPTY_SCENE);
        return;
      }
      const run = ++this.runId;
      if (this.cacheFor !== ctx) {
        this.sceneCache.clear();
        this.cacheFor = ctx;
      }
      const key = `${view.level}|${view.focusId ?? ''}`;
      const cached = this.sceneCache.get(key);
      this.busy.set(!cached);
      this.error.set('');
      (cached ? Promise.resolve(cached) : this.elk.layout(view, ctx)).then(
        scene => {
          if (run !== this.runId) return;
          this.sceneCache.set(key, scene);
          this.scene.set(scene);
          this.busy.set(false);
          setTimeout(() => (this.pendingReveal ? this.centreOn(this.pendingReveal) : this.pendingPathFit ? this.fitPath() : this.fit()));
        },
        err => {
          if (run !== this.runId) return;
          this.pendingReveal = undefined;
          this.error.set(String(err?.message ?? err));
          this.busy.set(false);
        },
      );
    });
  }

  private revealEffect = effect(() => {
    const r = this.reveal();
    const idx = this.idx();
    if (!r || !idx) return;
    // only a new reveal request (or graph) may move the map — reading level/focus/scene tracked here would
    // re-apply this reveal on every later level or focus change and pin the map to it
    untracked(() => this.applyReveal(r, idx));
  });

  private applyReveal(r: { id: string }, idx: GraphIndex): void {
    const n = idx.node(r.id);
    if (!n) return;
    const lv = kindInfo(n.kind).level;
    const network = n.kind === 'network' ? n : idx.ancestorOfKind(n.id, 'network');
    let level: Level = (lv >= 1 && lv <= 4 ? lv : 3) as Level;
    if (level === 4 && !network) level = 3;
    const focus = level === 1 ? undefined : network?.id;
    this.pendingReveal = r.id;
    if (level === this.level() && focus === this.focusId() && this.scene().boxes.length) {
      setTimeout(() => this.centreOn(r.id));
    } else {
      this.focusId.set(focus);
      this.level.set(level);
    }
  }

  /** A new path: switch to the unfocused level that draws most of its hops and fit to them. Clearing it refits. */
  private pathEffect = effect(() => {
    const p = this.path();
    const idx = this.idx();
    untracked(() => {
      if (!idx) return;
      if (!p || !p.hops.length) {
        this.pendingPathFit = false;
        if (this.scene().boxes.length) setTimeout(() => this.fit());
        return;
      }
      const level = pathLevel(idx, p);
      this.pendingPathFit = true;
      if (level === this.level() && !this.focusId() && this.scene().boxes.length) setTimeout(() => this.fitPath());
      else {
        this.focusId.set(undefined);
        this.level.set(level);
      }
    });
  });

  private fitPath(): void {
    this.pendingPathFit = false;
    const el = this.stage()?.nativeElement;
    const b = this.overlay()?.bounds;
    if (!el || !b) return this.fit();
    const w = el.clientWidth;
    const h = el.clientHeight;
    const pad = 70;
    const k = Math.max(0.15, Math.min(w / (b.w + pad * 2), h / (b.h + pad * 2), 1.2));
    this.setView(w / 2 - (b.x + b.w / 2) * k, h / 2 - (b.y + b.h / 2) * k, k);
  }

  /** Select and centre the node, or — when this level folds it into something else — the nearest drawn ancestor or neighbour. */
  private centreOn(id: string): void {
    this.pendingReveal = undefined;
    const idx = this.idx();
    const s = this.scene();
    if (!idx) return;
    const boxes = new Map(s.boxes.map(b => [b.id, b]));
    const candidates = [id, ...idx.ancestors(id).map(a => a.id), ...idx.out(id).map(e => e.to), ...idx.in(id).map(e => e.from)];
    const b = candidates.map(c => boxes.get(c)).find(Boolean);
    if (!b) return this.fit();
    this.selectedId.set(b.id);
    const el = this.stage()?.nativeElement;
    if (!el) return;
    const k = Math.max(this.k, 0.9);
    this.setView(el.clientWidth / 2 - (b.x + b.w / 2) * k, el.clientHeight / 2 - (b.y + b.h / 2) * k, k);
  }

  protected setLevel(l: Level): void {
    if (l === 4 && !this.canL4()) return;
    // L1 is the overview: a focus left over from drilling in would hide every other network
    if (l === 1) this.focusId.set(undefined);
    this.level.set(l);
  }

  /** Whole blueprint at L1, nothing selected, fitted (the page's Clear button). */
  resetView(): void {
    this.selectedId.set(undefined);
    this.pendingReveal = undefined;
    const wasHome = this.level() === 1 && !this.focusId();
    this.focusId.set(undefined);
    this.level.set(1);
    if (wasHome) setTimeout(() => this.fit());
  }

  protected setFocus(id: string | undefined): void {
    this.focusId.set(id);
    if (!id && this.level() === 4) this.level.set(3);
  }

  protected pickBox(ev: Event, b: SceneBox): void {
    ev.stopPropagation();
    if (this.suppressClick) return;
    this.selectedId.set(b.id);
    const v = this.view()?.nodes.find(n => n.id === b.id);
    if (v?.aggregate) this.selected.emit({ kind: 'aggregate', id: v.id, label: v.label, memberIds: v.aggregate.memberIds });
    else this.selected.emit({ kind: 'node', id: b.id });
  }

  protected pickEdge(ev: Event, e: SceneEdge): void {
    ev.stopPropagation();
    if (this.suppressClick) return;
    this.selectedId.set(e.id);
    this.selected.emit({ kind: 'edge', id: e.id, from: e.from, to: e.to, kinds: e.kinds, count: e.count, edgeIds: e.edgeIds });
  }

  protected clearSelection(): void {
    if (this.suppressClick) return;
    this.selectedId.set(undefined);
    this.selected.emit(null);
  }

  /** Double-click opens a container (or a network/hub card) one level deeper, scoped to it. */
  protected drill(ev: Event, b: SceneBox): void {
    ev.stopPropagation();
    if (b.boundary || b.id.startsWith('agg:')) return;
    if (!b.container && !['network', 'hub', 'account', 'subnet', 'vpn-connection'].includes(b.kind)) return;
    this.focusId.set(b.id);
    const next = Math.min(4, this.level() + 1) as Level;
    this.level.set(next === 4 && !this.canL4() ? 3 : next);
  }

  protected zoomBy(factor: number): void {
    const el = this.stage()?.nativeElement;
    const w = el?.clientWidth ?? 800;
    const h = el?.clientHeight ?? 600;
    const k = this.k;
    const nk = clampZoom(k * factor);
    this.setView(w / 2 - (w / 2 - this.tx) * (nk / k), h / 2 - (h / 2 - this.ty) * (nk / k), nk);
  }

  fit(): void {
    const el = this.stage()?.nativeElement;
    const s = this.scene();
    if (!el || !s.width || !s.height) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const k = Math.min(w / s.width, h / s.height, 1.2) * 0.95;
    this.setView((w - s.width * k) / 2, Math.max(8, (h - s.height * k) / 2), k);
  }

  // --- view transform -------------------------------------------------------------------------------------------

  /** Programmatic moves (fit, centre, zoom buttons): already inside the zone, so the label signal updates normally. */
  private setView(tx: number, ty: number, k: number): void {
    this.tx = tx;
    this.ty = ty;
    this.k = k;
    this.applyTransform();
    this.zoomPct.set(Math.round(k * 100));
  }

  private applyTransform(): void {
    this.world()?.nativeElement.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.k})`);
  }

  /** Gesture end (outside the zone): enter the zone only if the zoom label actually changes. */
  private syncZoomLabel(): void {
    const pct = Math.round(this.k * 100);
    if (pct !== this.zoomPct()) this.zone.run(() => this.zoomPct.set(pct));
  }

  // --- pan / zoom gestures, outside NgZone ------------------------------------------------------------------------

  private bindGestures(): void {
    const stage = this.stage()?.nativeElement;
    if (!stage) return;
    this.applyTransform();
    const listeners: [string, EventListener, AddEventListenerOptions | undefined][] = [
      ['pointerdown', e => this.onDown(e as PointerEvent), undefined],
      ['pointermove', e => this.onMove(e as PointerEvent), undefined],
      ['pointerup', () => this.onUp(), undefined],
      ['pointerleave', () => this.onUp(), undefined],
      ['wheel', e => this.onWheel(e as WheelEvent), { passive: false }],
    ];
    this.zone.runOutsideAngular(() => {
      for (const [type, fn, opts] of listeners) stage.addEventListener(type, fn, opts);
    });
    this.destroyRef.onDestroy(() => {
      for (const [type, fn, opts] of listeners) stage.removeEventListener(type, fn, opts);
    });
  }

  /** Pause line animations while the wheel is turning (class toggled directly; the timer runs outside the zone). */
  private markMoving(): void {
    this.canvas()?.nativeElement.classList.add('nm-moving');
    clearTimeout(this.movingTimer);
    this.movingTimer = setTimeout(() => this.canvas()?.nativeElement.classList.remove('nm-moving'), 180);
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    this.markMoving();
    const rect = this.stage()!.nativeElement.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const k = this.k;
    const nk = clampZoom(k * (ev.deltaY < 0 ? 1.1 : 0.9));
    this.tx = px - (px - this.tx) * (nk / k);
    this.ty = py - (py - this.ty) * (nk / k);
    this.k = nk;
    this.applyTransform();
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.syncZoomLabel(), 150);
  }

  private onDown(ev: PointerEvent): void {
    // drag starts anywhere on the canvas (boxes and lines included); a click is only a click if the pointer barely moved
    if (ev.button !== 0 || (ev.target as Element).closest('.nm-legend')) return;
    this.drag = { x: ev.clientX, y: ev.clientY, tx: this.tx, ty: this.ty };
  }

  private onMove(ev: PointerEvent): void {
    if (!this.drag) return;
    const dx = ev.clientX - this.drag.x;
    const dy = ev.clientY - this.drag.y;
    if (!this.dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      this.dragging = true;
      this.stage()?.nativeElement.classList.add('dragging');
    }
    this.tx = this.drag.tx + dx;
    this.ty = this.drag.ty + dy;
    this.applyTransform();
  }

  private onUp(): void {
    const wasDragging = this.dragging;
    this.dragging = false;
    this.drag = undefined;
    if (!wasDragging) return;
    this.stage()?.nativeElement.classList.remove('dragging');
    // the click that ends a drag must not select or deselect anything (the click handlers run in the zone and read
    // this flag; the timer is created here, outside the zone, so clearing it costs no change detection)
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false));
    this.syncZoomLabel();   // a pan leaves k unchanged, so this normally does nothing
  }
}

function clampZoom(k: number): number {
  return Math.min(3, Math.max(0.15, k));
}
