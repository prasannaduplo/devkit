import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GraphIndex } from '../src/app/model/graph-index';
import { ElkLike, layoutView } from '../src/app/model/layout';
import { boxClasses, previewHtml, sceneSvg } from '../src/app/model/scene-svg';
import { buildSeverity } from '../src/app/model/severity';
import { computeView, Level } from '../src/app/model/zoom';
import { hubFixture } from './fixture';

describe('preview', () => {
  it('renders all four levels to tests/out/preview.html', async () => {
    const idx = new GraphIndex(hubFixture().graph);
    const ctx = buildSeverity(idx);
    const elk = new ELK() as unknown as ElkLike;
    const egress = idx.byName('network', 'egress')!;
    const scenes = [];
    for (const [level, focus, title] of [
      [1, undefined, 'L1 · Very high — accounts, networks, hubs, outside world'],
      [2, undefined, 'L2 · High — gateways, VPNs, NAT / IGW'],
      [3, undefined, 'L3 · Mid — subnets, route tables, attachments'],
      [4, egress.id, 'L4 · Low — interfaces, workloads, security groups (egress VPC)'],
    ] as [Level, string | undefined, string][]) {
      scenes.push({ title, scene: await layoutView(computeView(idx, level, focus), elk, ctx) });
    }
    const svg = sceneSvg(scenes[0].scene);
    expect(svg).toContain('<svg');
    expect(svg).toContain('nm-flow');
    expect(svg).toContain('#nm-ic-');
    expect(boxClasses(scenes[0].scene.boxes[0])).toContain('nm-box');

    const out = new URL('./out/', import.meta.url);
    mkdirSync(out, { recursive: true });
    writeFileSync(new URL('preview.html', out), previewHtml('Network Map — renderer preview (synthetic hub)', scenes));
  });
});
