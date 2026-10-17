// Map CSS shared by the Angular map component (styles: [MAP_CSS]) and the static preview. Tokens follow the
// network-architecture palette the team reviewed; dark mode follows the portal's .dark-layout class (and a
// .nm-dark class for the preview). Lines "march" (decorative, not traffic-driven) unless reduced motion.
export const MAP_CSS = `
.nm-root{--nm-bg:#f4f6f8;--nm-surface:#ffffff;--nm-surface-2:#eef1f4;--nm-ink:#1a2129;--nm-ink-soft:#4a5560;--nm-faint:#778490;--nm-line:#dce1e6;--nm-line-strong:#c3ccd4;--nm-accent:#0d8f9e;--nm-ok:#0d8f9e;--nm-warn:#d08a1e;--nm-bad:#d6344c;--nm-stub:#a9b4bd;--nm-choke:#c07a12;--nm-choke-bg:#fbf1de;--nm-public-fill:#fff3d6;--nm-public-line:#e3a93c;--nm-private-fill:#dfe8fb;--nm-private-line:#7e98d6;color:var(--nm-ink);}
.nm-root.nm-dark,:host-context(.dark-layout) .nm-root{--nm-bg:#10151a;--nm-surface:#171e25;--nm-surface-2:#1e262e;--nm-ink:#e8edf1;--nm-ink-soft:#a9b4bd;--nm-faint:#8a96a1;--nm-line:#29333c;--nm-line-strong:#38434d;--nm-accent:#2bb6c4;--nm-ok:#2bb6c4;--nm-warn:#e0a44a;--nm-bad:#f0647a;--nm-stub:#5d6873;--nm-choke:#e0a44a;--nm-choke-bg:#2c2413;--nm-public-fill:#2e2614;--nm-public-line:#a9822f;--nm-private-fill:#16233a;--nm-private-line:#4f6ea8;}
.nm-canvas{background:var(--nm-bg);display:block;width:100%;height:100%;}
.nm-box{cursor:pointer;}
.nm-frame{fill:var(--nm-surface);stroke:var(--nm-line-strong);stroke-width:1.1;}
.nm-box.nm-container>.nm-frame{fill:var(--nm-surface-2);fill-opacity:.6;stroke-dasharray:4 4;}
.nm-box.kind-network>.nm-frame,.nm-box.kind-hub>.nm-frame{fill:var(--nm-surface);fill-opacity:1;stroke-dasharray:none;}
.nm-box.v-public>.nm-frame{fill:var(--nm-public-fill);fill-opacity:1;stroke:var(--nm-public-line);stroke-dasharray:none;}
.nm-box.v-private>.nm-frame{fill:var(--nm-private-fill);fill-opacity:1;stroke:var(--nm-private-line);stroke-dasharray:none;}
.nm-box.choke>.nm-frame{fill:var(--nm-choke-bg);fill-opacity:1;stroke:var(--nm-choke);stroke-width:1.5;stroke-dasharray:none;}
.nm-box.sev-warn>.nm-frame{stroke:var(--nm-warn);stroke-width:1.5;}
.nm-box.sev-bad>.nm-frame{stroke:var(--nm-bad);stroke-width:1.6;}
.nm-box.sev-stub>.nm-frame,.nm-box.boundary>.nm-frame{fill:transparent;stroke:var(--nm-stub);stroke-dasharray:3 3;}
.nm-box.selected>.nm-frame{stroke:var(--nm-accent);stroke-width:2.4;}
.nm-icon{color:var(--nm-accent);}
.nm-box.choke>.nm-icon{color:var(--nm-choke);}
.nm-box.sev-stub>.nm-icon,.nm-box.boundary>.nm-icon{color:var(--nm-stub);}
.nm-label{font:600 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--nm-ink);}
.nm-box.choke>.nm-label{fill:var(--nm-choke);}
.nm-sub{font:9.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--nm-faint);}
.nm-flow{fill:none;stroke-width:1.8;stroke-dasharray:3 5;animation:nm-march 1.1s linear infinite;}
.nm-flow.sev-ok{stroke:var(--nm-ok);}
.nm-flow.sev-warn{stroke:var(--nm-warn);}
.nm-flow.sev-bad{stroke:var(--nm-bad);stroke-width:2.1;}
.nm-flow.sev-stub{stroke:var(--nm-stub);animation:none;}
.nm-flow.selected{stroke-width:3.2;}
.nm-hit{fill:none;stroke:transparent;stroke-width:12;cursor:pointer;}
.nm-count{font:600 9px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--nm-ink-soft);paint-order:stroke;stroke:var(--nm-bg);stroke-width:3px;}
.nm-dim{opacity:.16;transition:opacity .2s;}
.nm-flow.nm-dim{animation:none;}
.nm-trace-layer{pointer-events:none;}
.nm-trace-under{fill:none;stroke:var(--nm-bg);stroke-width:7;stroke-linecap:round;opacity:.85;}
.nm-trace{fill:none;stroke-width:3.4;stroke-linecap:round;stroke-dasharray:1 8;animation:nm-march .8s linear infinite;}
.nm-trace.sev-ok{stroke:var(--nm-ok);}
.nm-trace.sev-warn{stroke:var(--nm-warn);}
.nm-trace.sev-bad{stroke:var(--nm-bad);}
.nm-badge rect{fill:var(--nm-surface);stroke-width:2;}
.nm-badge.sev-ok rect{stroke:var(--nm-ok);}
.nm-badge.sev-warn rect{stroke:var(--nm-warn);}
.nm-badge.sev-bad rect{stroke:var(--nm-bad);fill:var(--nm-bad);}
.nm-badge text{font:700 10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--nm-ink);}
.nm-badge.sev-bad text{fill:#fff;}
@keyframes nm-march{to{stroke-dashoffset:-16;}}
@media (prefers-reduced-motion: reduce){.nm-flow,.nm-trace{animation:none;}}
`;
