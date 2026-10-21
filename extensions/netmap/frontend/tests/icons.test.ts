import { describe, expect, it } from 'vitest';
import { ICON_IDS, ICON_PATHS, ICON_SPRITE, iconHref } from '../src/app/model/icons';
import { KINDS } from '../src/app/model/kinds';
import { MAP_CSS } from '../src/app/model/map-styles';

describe('icons', () => {
  it('cover every kind in the registry plus internet, site and generic', () => {
    for (const k of KINDS) expect(ICON_PATHS[k.icon], `icon for ${k.kind}`).toBeTruthy();
    for (const id of ['internet', 'site', 'generic']) expect(ICON_PATHS[id]).toBeTruthy();
  });

  it('use only simple SVG shapes', () => {
    for (const id of ICON_IDS) {
      const tags = [...ICON_PATHS[id].matchAll(/<(\w+)/g)].map(m => m[1]);
      expect(tags.length).toBeGreaterThan(0);
      for (const t of tags) expect(['path', 'rect', 'circle']).toContain(t);
    }
  });

  it('builds one sprite with a symbol per icon and falls back to generic', () => {
    expect(ICON_SPRITE.match(/<symbol /g)).toHaveLength(ICON_IDS.length);
    expect(iconHref('nat')).toBe('#nm-ic-nat');
    expect(iconHref('does-not-exist')).toBe('#nm-ic-generic');
  });

  it('map styles define light and dark tokens and respect reduced motion', () => {
    expect(MAP_CSS).toContain('--nm-bad');
    expect(MAP_CSS).toContain('.dark-layout');
    expect(MAP_CSS).toContain('prefers-reduced-motion');
    expect(MAP_CSS).toContain('@keyframes nm-march');
  });
});
