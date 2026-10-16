// DuploCloud-owned network icons. Thin line, 16×16 grid, stroke via currentColor — no third-party icon packs.
// Keys are the kind registry's icon ids (model/kinds.ts) plus 'internet', 'site' and 'generic'.
export const ICON_PATHS: Record<string, string> = {
  account: '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="8" cy="7" r="1.8"/><path d="M5 11.5c.7-1.4 1.8-2 3-2s2.3.6 3 2"/>',
  network: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M1.5 6h13M6 6v7.5"/>',
  hub: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.5v3.9M8 10.6v3.9M1.5 8h3.9M10.6 8h3.9"/>',
  peering: '<circle cx="4.5" cy="8" r="2.5"/><circle cx="11.5" cy="8" r="2.5"/><path d="M7 8h2"/>',
  external: '<path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z"/><path d="M8 14.5V8M2.5 4.5 8 8l5.5-3.5"/>',
  internet: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  vpn: '<rect x="4" y="7" width="8" height="6.5" rx="1.4"/><path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7"/>',
  'vpn-gateway': '<rect x="2" y="5" width="12" height="7" rx="1.5"/><path d="M6.5 8.5h3M8 5V3.4"/><circle cx="8" cy="2.6" r=".9"/>',
  site: '<path d="M2 14V6l4-3v11M6 14V8h8v6M2 14h12"/>',
  'internet-gateway': '<path d="M3 14V6.5a5 5 0 0 1 10 0V14M6 14V9h4v5"/>',
  nat: '<rect x="2" y="3" width="8" height="10" rx="1.6"/><path d="M6 8h8.5M12 5.5 14.5 8 12 10.5"/>',
  'egress-only': '<path d="M3 14V6.5a5 5 0 0 1 10 0V14"/><path d="M8 12V6M5.8 8.2 8 6l2.2 2.2"/>',
  firewall: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6.3h12M2 9.7h12M6 3v3.3M10 6.3v3.4M6 9.7V13"/>',
  gateway: '<rect x="3" y="3" width="10" height="10" rx="2"/><path d="M6 8h4M8 6v4"/>',
  subnet: '<rect x="2" y="3" width="12" height="10" rx="1.4" stroke-dasharray="2 1.6"/>',
  'route-table': '<path d="M2.5 4h7M2.5 8h11M2.5 12h7M11 2l2.5 2L11 6M11 10l2.5 2L11 14"/>',
  attachment: '<path d="M6.5 9.5 9.5 6.5"/><path d="M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/>',
  'load-balancer': '<circle cx="8" cy="4" r="2"/><path d="M8 6v2.5M3 13l5-4.5 5 4.5"/><circle cx="3" cy="13" r="1.3"/><circle cx="13" cy="13" r="1.3"/>',
  endpoint: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v3.9M3 12.5l3.2-2.8M13 12.5l-3.2-2.8"/>',
  'dns-zone': '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M5 6.5h6M5 9.5h4"/>',
  'public-ip': '<circle cx="8" cy="8" r="5.8"/><path d="M6.3 11V5h2.2a1.6 1.6 0 0 1 0 3.2H6.3"/>',
  resolver: '<circle cx="7" cy="7" r="4.2"/><path d="M10 10l3.8 3.8"/>',
  'resolver-rule': '<path d="M3 4h10M3 8h6M3 12h8"/><path d="M11.5 6.5 14 9l-2.5 2.5"/>',
  interface: '<rect x="3" y="4" width="10" height="8" rx="1.5"/><path d="M5.5 12v2M8 12v2M10.5 12v2M6 7.5h4"/>',
  workload: '<path d="M8 1.8 14 5v6l-6 3.2L2 11V5zM2 5l6 3.2L14 5M8 8.2v6"/>',
  'security-group': '<path d="M8 1.8 13.5 4v4c0 3.2-2.4 5.3-5.5 6.2C4.9 13.3 2.5 11.2 2.5 8V4z"/>',
  nacl: '<path d="M8 1.8 13.5 4v4c0 3.2-2.4 5.3-5.5 6.2C4.9 13.3 2.5 11.2 2.5 8V4z"/><path d="M5.5 8h5"/>',
  'dns-record': '<rect x="3" y="3.5" width="10" height="9" rx="1"/><path d="M5.5 6.5h5M5.5 9.5h3"/>',
  tunnel: '<path d="M2 12V8a6 6 0 0 1 12 0v4"/><path d="M5 12V8.5a3 3 0 0 1 6 0V12"/>',
  cidr: '<path d="M3 5h10M3 11h10M6 2.5v11M10 2.5v11"/>',
  'flow-logs': '<path d="M2 12l3.5-4 3 2.5L14 4"/><path d="M11 4h3v3"/>',
  'dns-logs': '<rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h3.5"/>',
  generic: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v3"/><circle cx="8" cy="11" r=".6"/>',
};

export const ICON_IDS = Object.keys(ICON_PATHS);

export function iconHref(id: string): string {
  return `#nm-ic-${ICON_PATHS[id] ? id : 'generic'}`;
}

function symbol(id: string): string {
  return `<symbol id="nm-ic-${id}" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[id]}</g></symbol>`;
}

/** One hidden SVG holding every symbol; injected once into the page (shared/icon-sprite.component.ts). */
export const ICON_SPRITE =
  `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>${ICON_IDS.map(symbol).join('')}</defs></svg>`;
