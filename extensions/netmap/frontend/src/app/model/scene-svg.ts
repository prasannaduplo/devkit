import { ICON_SPRITE, iconHref } from './icons';
import { Scene, SceneBox, SceneEdge } from './layout';
import { MAP_CSS } from './map-styles';

/** CSS classes for a box — shared by the Angular template and the static preview. */
export function boxClasses(b: SceneBox, selectedId?: string): string {
  return [
    'nm-box', `kind-${b.kind}`, `sev-${b.severity}`,
    b.container ? 'nm-container' : 'nm-leaf',
    b.chokepoint ? 'choke' : '', b.boundary ? 'boundary' : '',
    b.variant ? `v-${b.variant}` : '',
    b.id === selectedId ? 'selected' : '',
  ].filter(Boolean).join(' ');
}

export function edgeClasses(e: SceneEdge, selectedId?: string): string {
  return ['nm-flow', `sev-${e.severity}`, e.id === selectedId ? 'selected' : ''].filter(Boolean).join(' ');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Standalone SVG of a scene (preview only; the component renders the same structure with Angular bindings).
 * Draw order: container frames, then edges, then leaf cards — lines run over containers but under cards. */
export function sceneSvg(scene: Scene): string {
  const containerSvg = scene.boxes.filter(b => b.container).map(sceneBoxSvg).join('');
  const leafSvg = scene.boxes.filter(b => !b.container).map(sceneBoxSvg).join('');
  const edges = scene.edges.map(e =>
    `<path class="${edgeClasses(e)}" d="${e.d}"/>` + (e.count > 1 ? `<text class="nm-count" x="${e.mid.x}" y="${e.mid.y - 4}" text-anchor="middle">${e.count}×</text>` : ''),
  ).join('');
  const w = Math.ceil(scene.width);
  const h = Math.ceil(scene.height);
  return `<svg class="nm-canvas" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${containerSvg}${edges}${leafSvg}</svg>`;
}

function sceneBoxSvg(b: SceneBox): string {
  return [
    `<g class="${boxClasses(b)}" transform="translate(${b.x},${b.y})">`,
    `<rect class="nm-frame" width="${b.w}" height="${b.h}" rx="8"/>`,
    `<use class="nm-icon" href="${iconHref(b.icon)}" x="${b.ix}" y="${b.iy}" width="16" height="16"/>`,
    `<text class="nm-label" x="${b.lx}" y="${b.ly}">${esc(b.label)}</text>`,
    b.sublabel ? `<text class="nm-sub" x="${b.lx}" y="${b.sy}">${esc(b.sublabel)}</text>` : '',
    `</g>`,
  ].join('');
}

export function previewHtml(title: string, scenes: { title: string; scene: Scene }[]): string {
  const section = (dark: boolean) => scenes.map(s =>
    `<section class="nm-root${dark ? ' nm-dark' : ''}"><h2>${esc(s.title)}${dark ? ' — dark' : ''}</h2><div class="frame">${sceneSvg(s.scene)}</div></section>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;padding:16px;font:14px system-ui,sans-serif;background:#e9edf1;}
h1{font-size:18px;margin:0 0 12px;} h2{font:600 12px ui-monospace,monospace;margin:0 0 8px;color:var(--nm-ink);}
section{background:var(--nm-bg);border-radius:12px;padding:12px;margin-bottom:16px;}
.frame{overflow:auto;}
${MAP_CSS}
</style></head><body>${ICON_SPRITE}<h1>${esc(title)}</h1>${section(false)}${section(true)}</body></html>`;
}
