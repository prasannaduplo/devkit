import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, ViewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import {
  NetworkMapService, NetworkMap, VpcSummary, VpcDetail, SubnetLane, SecurityGroupCard, ResourceNode, ConnectionEdge, EndpointInfo,
  VpnGatewayInfo, TransitGatewayInfo, VpcPeeringInfo,
} from '../network-map.service';

// Account view (list of VPCs with a risk count) drilling down into a per-VPC security-posture canvas:
// AZ -> subnet -> security-group card -> attached resources, pannable/zoomable, with connections
// aggregated to card-to-card edges (not one line per resource pair -- a VPC with 50+ ENIs sharing a
// handful of groups renders as a handful of cards/edges instead of hundreds of lines). Positions are
// computed client-side from whatever NetworkMapController.VpcDetail returns (no server-side layout), so
// this scales to any VPC shape without a template change. See EXTENSION_BACKLOG.md #55 for the original
// requirement this closes, and the netmap-redesign mockup for the design this implements.

type Severity = 'bad' | 'warn' | 'ok';

interface PositionedCard {
  id: string; card: SecurityGroupCard; x: number; y: number; w: number; h: number; severity: Severity;
}
interface PositionedSubnet {
  subnetId: string; cidr: string; isPublic: boolean; x: number; y: number; w: number; h: number;
  externalRouteTargets: string[];
}
interface PositionedBadge {
  id: string; kind: string; color: string; x: number; y: number; size: number; label?: string;
}
interface BadgeEdge { x1: number; y1: number; x2: number; y2: number; kind: string; }
interface PositionedAz {
  id: string; x: number; w: number; label: string;
}
interface PositionedEdge {
  key: string; x1: number; y1: number; x2: number; y2: number; internet: boolean; count: number; edge: ConnectionEdge;
}
interface CardMeta { card: SecurityGroupCard; subnet: SubnetLane; }

// LEFT/RIGHT_MARGIN are wider than the content strictly needs so every VPC canvas has a consistent home
// for the on-prem/Transit-Gateway pseudo-nodes, whether or not THIS VPC happens to use them.
const AZ_W = 460, AZ_GAP = 36, LEFT = 160, RIGHT_MARGIN = 150, TOP = 110;
const SUB_PAD_X = 14, SUB_PAD_TOP = 44, SUB_GAP = 18;
const SG_W = 148, SG_H = 68, SG_GAP = 12, SG_ROW_GAP = 12;
const CARDS_PER_ROW = 2;
const INTERNET_Y = 20;

const ICONS: Record<string, { grp: string; glyph: string }> = {
  'EC2 Instance': { grp: 'compute', glyph: 'EC2' },
  'RDS': { grp: 'db', glyph: 'RDS' },
  'Load Balancer': { grp: 'net', glyph: 'ELB' },
  'Lambda': { grp: 'compute', glyph: 'λ' },
  'NAT Gateway': { grp: 'net', glyph: 'NAT' },
};
const GRP_COLOR: Record<string, string> = {
  compute: '#ED7100', db: '#2E73B8', storage: '#4d8a00', net: '#8C4FFF',
};

// ---------------------------------------------------------------------
// Icon badges for connectivity nodes (on-prem / VPN / Transit Gateway /
// Peering). AWS's own Architecture Icons can't be pulled into this
// bundle -- there's no bundled copy of the asset files and no sanctioned
// host to fetch them from at runtime -- so these are hand-drawn
// pictograms in AWS's own convention instead: one rounded-square badge
// shape for every kind (AWS doesn't vary the shape per service), white
// line-art, AWS's real networking-purple category color.
// ---------------------------------------------------------------------
const GLYPH: Record<string, string> = {
  onprem: `<rect x="17" y="13" width="30" height="38" rx="2"/>
    <line x1="17" y1="24" x2="47" y2="24"/><line x1="17" y1="35" x2="47" y2="35"/><line x1="32" y1="13" x2="32" y2="51"/>
    <rect x="21" y="16" width="6" height="5" fill="#fff" stroke="none"/><rect x="37" y="16" width="6" height="5" fill="#fff" stroke="none"/>
    <rect x="21" y="27" width="6" height="5" fill="#fff" stroke="none"/><rect x="37" y="27" width="6" height="5" fill="#fff" stroke="none"/>`,
  vpn: `<path d="M22,30 v-6 a10,10 0 0 1 20,0 v6" fill="none"/>
    <rect x="17" y="30" width="30" height="21" rx="4"/>
    <circle cx="32" cy="38" r="3" fill="#fff" stroke="none"/><line x1="32" y1="41" x2="32" y2="45"/>`,
  tgw: `<circle cx="32" cy="32" r="7"/>
    <circle cx="32" cy="13" r="4"/><circle cx="51" cy="32" r="4"/><circle cx="32" cy="51" r="4"/><circle cx="13" cy="32" r="4"/>
    <line x1="32" y1="25" x2="32" y2="17"/><line x1="39" y1="32" x2="47" y2="32"/><line x1="32" y1="39" x2="32" y2="47"/><line x1="25" y1="32" x2="17" y2="32"/>`,
  peer: `<circle cx="25" cy="32" r="14" fill="none"/><circle cx="39" cy="32" r="14" fill="none"/>`,
};
const NET_COLOR = '#8C4FFF', ONPREM_COLOR = '#475569';

@Component({
  selector: 'nm-view',
  imports: [DatePipe],
  styles: [`
    :host { display: block; font-family: 'IBM Plex Sans', -apple-system, sans-serif; }
    .wrap { padding: 20px 24px 40px; }
    h3 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
    .muted { color: #64748B; font-size: 13px; }
    .error-banner { background: #FDECEC; border: 1px solid #F5C2C2; color: #B91C1C; border-radius: 8px; padding: 10px 14px; font-size: 13.5px; margin-top: 14px; }

    /* ── account grid ── */
    .vpc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; margin-top: 20px; }
    .vpc-card { background: #fff; border: 1px solid #E2E8F0; border-radius: 12px; padding: 16px 18px; cursor: pointer; transition: border-color .15s; }
    .vpc-card:hover { border-color: #2563EB; }
    .vpc-name { font-weight: 600; font-size: 14.5px; }
    .vpc-id { font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: #94A3B8; margin-top: 2px; }
    .vpc-meta { display: flex; align-items: center; gap: 6px; margin-top: 14px; font-size: 12.5px; color: #5B6B82; flex-wrap: wrap; }
    .vpc-meta .sep-dot { color: #CBD5E1; }
    .link-count { color: #2563EB; font-weight: 700; cursor: pointer; text-decoration: none; }
    .link-count:hover { text-decoration: underline; }
    .vpc-pills { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .risk-pill { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px; }
    .risk-pill.bad { background: #FDECEC; color: #B91C1C; }
    .risk-pill.warn { background: #FFF7EB; color: #92600F; }
    .risk-pill.good { background: #E9F8EF; color: #15803D; }

    .endpoints-head { margin-top: 30px; }
    .endpoints-head h4 { margin: 0 0 2px; font-size: 15px; font-weight: 700; }
    .endpoints-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .endpoint-row { display: flex; gap: 12px; align-items: flex-start; background: #fff; border: 1px solid #E2E8F0; border-radius: 10px; padding: 12px 16px; cursor: pointer; transition: border-color .15s; }
    .endpoint-row:hover { border-color: #2563EB; }
    .scheme-pill { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 3px 9px; border-radius: 999px; background: #EEF2F6; color: #5B6B82; flex: none; margin-top: 2px; white-space: nowrap; }
    .scheme-pill.public { background: #EFF6FF; color: #2563EB; }
    .endpoint-main { flex: 1; min-width: 0; }
    .endpoint-url { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; font-weight: 600; word-break: break-all; }
    .endpoint-url.muted { color: #94A3B8; font-weight: 500; }
    .endpoint-sub { font-size: 11px; color: #94A3B8; margin-top: 3px; }

    /* ── account tabs + connectivity topology ── */
    .acct-tabs { display: flex; gap: 4px; background: #F1F3F6; border: 1px solid #E2E8F0; border-radius: 10px; padding: 3px; margin: 16px 0 4px; width: fit-content; }
    .acct-tabs button { border: none; background: none; padding: 7px 14px; border-radius: 7px; font-size: 12.5px; font-weight: 700; color: #64748B; cursor: pointer; }
    .acct-tabs button.active { background: #fff; color: #2563EB; box-shadow: 0 1px 2px rgba(20,24,38,.08); }
    .conn-shell { height: 60vh; min-height: 420px; }
    .icon-badge { cursor: pointer; }
    .icon-badge rect { filter: drop-shadow(0 2px 4px rgba(20,24,38,.15)); }
    .node-ext-label { font-size: 10.5px; font-weight: 700; fill: #1A2233; }
    .conn-vpc-box { fill: #fff; stroke: #D7DCE5; stroke-width: 1.4; filter: drop-shadow(0 1px 2px rgba(20,24,38,.1)); }
    .conn-vpc-box.selected { stroke: #6a4cff; stroke-width: 2.5; }
    .conn-vpc-name { font-size: 11.5px; font-weight: 800; fill: #1A2233; }
    .conn-vpc-sub { font-size: 9.5px; fill: #64748B; font-family: 'IBM Plex Mono', monospace; }
    .risk-dot.bad { fill: #d6344c; } .risk-dot.warn { fill: #c9821a; } .risk-dot.ok { fill: #1c8a53; }
    .conn-edge { fill: none; stroke-width: 1.8; }
    .conn-edge.vpn { stroke: #1c8a53; stroke-dasharray: 6 4; }
    .conn-edge.tgw { stroke: #8C4FFF; stroke-dasharray: 3 3; }
    .conn-edge.peer { stroke: #c9821a; stroke-dasharray: 8 3; }
    .conn-edge-lbl { font-size: 9.5px; font-weight: 700; fill: #64748B; }

    .attach-row { display: flex; justify-content: space-between; align-items: center; padding: 10px; border: 1px solid #E2E8F0; border-radius: 9px; margin-bottom: 8px; }
    .attach-row .name { font-weight: 700; font-size: 12px; }
    .attach-row .cidr { font-size: 10.5px; color: #94A3B8; font-family: 'IBM Plex Mono', monospace; }
    .status-pill { font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 999px; }
    .status-pill.up { background: #E9F8EF; color: #15803D; }
    .status-pill.down { background: #FDECEC; color: #B91C1C; }
    .kv { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid #E2E8F0; font-size: 12.5px; }
    .kv .k { color: #64748B; } .kv .v { font-weight: 700; font-family: 'IBM Plex Mono', monospace; text-align: right; }

    /* ── drill-down canvas ── */
    .back-link { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: #2563EB; cursor: pointer; margin-bottom: 14px; background: none; border: none; padding: 0; }
    .canvas-shell { position: relative; height: 70vh; min-height: 480px; border: 1px solid #E2E8F0; border-radius: 14px; overflow: hidden;
      background: radial-gradient(circle, #E7EAF0 1px, transparent 1px) 0 0/22px 22px, #F7F8FA; }
    .canvas-shell svg { display: block; width: 100%; height: 100%; cursor: grab; }
    .canvas-shell svg:active { cursor: grabbing; }

    .toolbar { position: absolute; left: 14px; bottom: 14px; z-index: 5; display: flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #E2E8F0; border-radius: 12px; padding: 6px; box-shadow: 0 4px 16px -6px rgba(20,24,38,.2); }
    .toolbar button { width: 28px; height: 28px; border-radius: 7px; border: none; background: transparent; color: #1A2233; font-size: 14px; cursor: pointer; }
    .toolbar button:hover { background: #EFEAFF; color: #6A4CFF; }
    .toolbar .zoom-readout { font-size: 11px; color: #64748B; padding: 0 4px; font-variant-numeric: tabular-nums; }
    .toolbar .sep { width: 1px; align-self: stretch; background: #E2E8F0; margin: 0 2px; }
    .toolbar .inv-btn { width: auto; padding: 0 10px; font-size: 11.5px; font-weight: 700; display: flex; align-items: center; gap: 5px; }
    .toolbar .toggle { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #5B6B82; padding: 0 6px; white-space: nowrap; }
    .toolbar .toggle input { accent-color: #d6344c; }

    .legend { position: absolute; right: 14px; bottom: 14px; z-index: 5; background: #fff; border: 1px solid #E2E8F0; border-radius: 12px; padding: 9px 13px; box-shadow: 0 4px 16px -6px rgba(20,24,38,.2); font-size: 11px; color: #64748B; display: flex; gap: 12px; flex-wrap: wrap; max-width: 420px; }
    .legend span.item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }

    .az-box { fill: none; stroke: #94A3B8; stroke-dasharray: 5 4; stroke-width: 1.2; opacity: .6; }
    .vpc-box { fill: none; stroke: #2e9e5b; stroke-dasharray: 7 5; stroke-width: 1.6; }
    .subnet-box.public { fill: #FFF3D6; stroke: #E3A93C; }
    .subnet-box.private { fill: #DFE8FB; stroke: #7E98D6; }
    .lbl { font-size: 11px; fill: #64748B; font-weight: 700; letter-spacing: .02em; }
    .lbl.strong { fill: #1A2233; }
    .cidr-lbl { font-size: 9.5px; fill: #64748B; font-family: 'IBM Plex Mono', monospace; }

    .edge-hit { fill: none; stroke: transparent; stroke-width: 16; cursor: pointer; }
    .edge-line { fill: none; stroke-width: 1.6; pointer-events: none; }
    .edge-line.ok { stroke: #9aa1b4; }
    .edge-line.warn { stroke: #c9821a; stroke-dasharray: 4 3; }
    .edge-line.bad { stroke: #d6344c; stroke-dasharray: 4 3; }
    .edge-count { font-size: 9px; font-weight: 700; fill: #64748B; pointer-events: none; }
    .edge-count.warn { fill: #c9821a; }
    .edge-count.bad { fill: #d6344c; }

    .sg-card { cursor: pointer; }
    .sg-card rect.body { fill: #fff; stroke: #D7DCE5; stroke-width: 1.2; filter: drop-shadow(0 1px 1px rgba(20,24,38,.12)); }
    .sg-card.bad rect.body { stroke: #d6344c; stroke-width: 1.8; }
    .sg-card.warn rect.body { stroke: #c9821a; stroke-width: 1.6; }
    .sg-card.selected rect.body { stroke: #6a4cff; stroke-width: 2; }
    .sg-card text.name { font-size: 10.5px; font-weight: 700; fill: #1A2233; }
    .sg-card text.count { font-size: 9px; fill: #64748B; }
    .sg-card text.flag-bad { font-size: 8.5px; font-weight: 800; fill: #d6344c; }
    .sg-card text.flag-warn { font-size: 8.5px; font-weight: 800; fill: #c9821a; }

    /* ── side detail panel ── */
    .detail { position: absolute; top: 0; right: 0; bottom: 0; width: 350px; background: #fff; border-left: 1px solid #E2E8F0; box-shadow: -8px 0 24px -12px rgba(20,24,38,.3); transform: translateX(100%); transition: transform .18s ease; z-index: 6; display: flex; flex-direction: column; }
    .detail.open { transform: translateX(0); }
    .detail-head { padding: 16px 18px; border-bottom: 1px solid #E2E8F0; display: flex; align-items: flex-start; gap: 10px; }
    .detail-head h4 { margin: 0; font-size: 14px; }
    .detail-head p { margin: 2px 0 0; font-size: 11px; color: #64748B; font-family: 'IBM Plex Mono', monospace; }
    .detail-close { margin-left: auto; background: none; border: none; color: #64748B; cursor: pointer; font-size: 16px; padding: 2px; }
    .detail-body { padding: 12px 14px; overflow-y: auto; flex: 1; }
    .inv-group-head { display: flex; align-items: center; gap: 8px; margin: 16px 0 8px; }
    .inv-group-head:first-child { margin-top: 0; }
    .inv-group-head .dot { width: 8px; height: 8px; border-radius: 50%; background: #1c8a53; flex: none; }
    .inv-group-head .dot.bad { background: #d6344c; }
    .inv-group-head .dot.warn { background: #c9821a; }
    .inv-group-name { font-size: 12.5px; font-weight: 700; }
    .inv-group-sub { font-size: 10.5px; color: #94A3B8; }
    .res-row { display: flex; gap: 10px; padding: 10px; border: 1px solid #E2E8F0; border-radius: 10px; margin-bottom: 8px; align-items: flex-start; }
    .res-row.bad { border-color: #d6344c; background: #FDECEC; }
    .res-row.warn { border-color: #e8b668; background: #FFF7EB; }
    .res-icon { width: 30px; height: 30px; border-radius: 7px; flex: none; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12.5px; font-weight: 800; }
    .res-row .name { font-size: 12.5px; font-weight: 700; }
    .res-row .kind { font-size: 10.5px; color: #64748B; }
    .res-row .sub { font-size: 10px; color: #94A3B8; margin-top: 1px; }
    .res-row .flags { display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap; }
    .res-url { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; font-weight: 600; color: #2563EB; word-break: break-all; margin-top: 3px; }
    .mini-pill { font-size: 9.5px; font-weight: 700; padding: 1.5px 6px; border-radius: 999px; color: #fff; }
    .mini-pill.bad { background: #d6344c; }
    .mini-pill.warn { background: #c9821a; }

    .rule-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 7px; font-size: 12px; }
    .rule-row.warn { border-color: #c9821a; background: #FFF7EB; color: #92600F; }
    .rule-row.bad { border-color: #d6344c; background: #FDECEC; color: #B91C1C; }
    .rule-row .count { font-weight: 700; font-variant-numeric: tabular-nums; }
    .conn-ends { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; margin-bottom: 4px; }
    .conn-ends .arrow { color: #94A3B8; }
  `],
  template: `
    @if (item(); as it) {
      <div class="wrap">
        <h3>{{ selectedVpcId() ? selectedVpcName() : it.name }}</h3>
        <p class="muted">
          @if (!selectedVpcId()) {
            AWS region <strong>{{ it.spec?.region }}</strong>
            @if (it.result?.lastScannedAt) { · last scanned {{ it.result!.lastScannedAt | date:'medium' }} }
          } @else {
            {{ it.name }} · {{ selectedVpcId() }}
          }
        </p>

        @if (it.result?.scanError) {
          <div class="error-banner">Scan failed: {{ it.result!.scanError }}</div>
        }

        @if (!selectedVpcId()) {
          <!-- ── Account view ── -->
          <div class="acct-tabs">
            <button [class.active]="accountTab() === 'vpcs'" (click)="accountTab.set('vpcs')">VPCs</button>
            <button [class.active]="accountTab() === 'connectivity'" (click)="accountTab.set('connectivity')">Connectivity</button>
          </div>

          @if (accountTab() === 'vpcs') {
          @if ((it.result?.vpcs?.length ?? 0) === 0 && !it.result?.scanError) {
            <p class="muted" style="margin-top:20px">No VPCs found in this region.</p>
          }
          <div class="vpc-grid">
            @for (vpc of it.result?.vpcs; track vpc.vpcId) {
              <div class="vpc-card" (click)="selectVpc(vpc)">
                <div class="vpc-name">{{ vpc.name }}</div>
                <div class="vpc-id">{{ vpc.vpcId }} · {{ vpc.cidr }}</div>
                <div class="vpc-meta">
                  <span>{{ vpc.subnetCount }} subnet{{ vpc.subnetCount === 1 ? '' : 's' }}</span>
                  <span class="sep-dot">·</span>
                  <a class="link-count" (click)="openVpcInventory(vpc, $event)" title="View every resource in this VPC">{{ vpc.resourceCount }} resource{{ vpc.resourceCount === 1 ? '' : 's' }}</a>
                  @if (endpointCount(vpc, it.result?.endpoints) > 0) {
                    <span class="sep-dot">·</span>
                    <span>{{ endpointCount(vpc, it.result?.endpoints) }} endpoint{{ endpointCount(vpc, it.result?.endpoints) === 1 ? '' : 's' }}</span>
                  }
                </div>
                <div class="vpc-pills">
                  @if (vpc.inboundOpenSecurityGroupCount > 0) {
                    <span class="risk-pill bad">{{ vpc.inboundOpenSecurityGroupCount }} inbound open</span>
                  } @else {
                    <span class="risk-pill good">no inbound exposure</span>
                  }
                  @if (vpc.outboundOpenSecurityGroupCount > 0) {
                    <span class="risk-pill warn">{{ vpc.outboundOpenSecurityGroupCount }} outbound open</span>
                  }
                </div>
              </div>
            }
          </div>

          @if ((it.result?.endpoints?.length ?? 0) > 0) {
            <div class="endpoints-head">
              <h4>Public &amp; internal endpoints</h4>
              <p class="muted">Load balancers cross-referenced with Route53 — what's actually reachable, and by what name. Click one to see it in context.</p>
            </div>
            <div class="endpoints-list">
              @for (ep of it.result?.endpoints; track ep.dnsName) {
                <div class="endpoint-row" (click)="jumpToVpc(ep.vpcId, it.result?.vpcs, $event)">
                  <span class="scheme-pill" [class.public]="ep.scheme === 'internet-facing'">{{ ep.scheme === 'internet-facing' ? 'public' : 'internal' }}</span>
                  <div class="endpoint-main">
                    @if (ep.urls.length > 0) {
                      @for (u of ep.urls; track u) { <div class="endpoint-url">{{ u }}</div> }
                    } @else {
                      <div class="endpoint-url muted">{{ ep.dnsName }}</div>
                    }
                    <div class="endpoint-sub">{{ ep.name }} · {{ ep.vpcId }}</div>
                  </div>
                </div>
              }
            </div>
          }
          }

          @if (accountTab() === 'connectivity') {
            @if (connectivityDiagram(); as cd) {
              <div class="canvas-shell conn-shell">
                <svg viewBox="0 0 {{ cd.width }} {{ cd.height }}" preserveAspectRatio="xMidYMid meet" (click)="closeConnPanel()">
                  @for (e of cd.edges; track e.x1 + '-' + e.y1 + '-' + e.x2 + '-' + e.y2) {
                    <line class="conn-edge" [class.vpn]="e.kind==='vpn'" [class.tgw]="e.kind==='tgw'" [class.peer]="e.kind==='peer'"
                          [attr.x1]="e.x1" [attr.y1]="e.y1" [attr.x2]="e.x2" [attr.y2]="e.y2" />
                  }
                  @for (lbl of cd.edgeLabels; track lbl.text) {
                    <text class="conn-edge-lbl" [attr.x]="lbl.x" [attr.y]="lbl.y" text-anchor="middle">{{ lbl.text }}</text>
                  }
                  @for (v of cd.vpcBoxes; track v.id) {
                    <g [attr.transform]="'translate(' + v.x + ',' + v.y + ')'" style="cursor:pointer" (click)="jumpToVpc(v.id, it.result?.vpcs, $event)">
                      <rect class="conn-vpc-box" [class.selected]="false" x="0" y="0" [attr.width]="v.w" [attr.height]="v.h" rx="10" />
                      <circle class="risk-dot" [class.bad]="v.risk==='bad'" [class.warn]="v.risk==='warn'" [class.ok]="v.risk==='ok'" cx="14" cy="16" r="5" />
                      <text class="conn-vpc-name" x="26" y="20">{{ truncate(v.name, 16) }}</text>
                      <text class="conn-vpc-sub" x="14" y="38">{{ v.cidr }}</text>
                      <text class="conn-vpc-sub" x="14" y="52">{{ v.via }}</text>
                    </g>
                  }
                  @for (b of cd.badges; track b.id) {
                    <g class="icon-badge" [attr.transform]="'translate(' + (b.x-b.size/2) + ',' + (b.y-b.size/2) + ')'" (click)="selectConnBadge(b, $event)">
                      <rect [attr.width]="b.size" [attr.height]="b.size" [attr.rx]="b.size*0.18" [attr.fill]="b.color" />
                      <g [attr.transform]="'scale(' + (b.size/64) + ')'" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none" [innerHTML]="glyphHtml(b.kind)"></g>
                    </g>
                    @if (b.label) { <text class="node-ext-label" [attr.x]="b.x" [attr.y]="b.y + b.size/2 + 16" text-anchor="middle">{{ b.label }}</text> }
                  }
                </svg>

                <div class="legend">
                  <span class="item"><span class="swatch" style="background:#1c8a53"></span>Site-to-Site VPN</span>
                  <span class="item"><span class="swatch" style="background:#8C4FFF"></span>Transit Gateway</span>
                  <span class="item"><span class="swatch" style="background:#c9821a"></span>VPC Peering (bypasses TGW)</span>
                  <span class="item">click any node for detail</span>
                </div>

                <div class="detail" [class.open]="connPanelData() !== null">
                  <div class="detail-head">
                    <div><h4>{{ connPanelData()?.title }}</h4><p>{{ connPanelData()?.sub }}</p></div>
                    <button class="detail-close" (click)="closeConnPanel()">✕</button>
                  </div>
                  <div class="detail-body">
                    @if (connPanelData(); as cp) {
                      @for (t of cp.tunnels ?? []; track t.customerGatewayIp) {
                        <div class="attach-row">
                          <div><div class="name">Tunnel</div><div class="cidr">CGW {{ t.customerGatewayIp }}</div></div>
                          <span class="status-pill" [class.up]="t.status==='UP'" [class.down]="t.status!=='UP'">{{ t.status }}</span>
                        </div>
                      }
                      @for (a of cp.attachments ?? []; track a.vpcId) {
                        <div class="attach-row"><div><div class="name">{{ a.name }}</div><div class="cidr">{{ a.vpcId }}</div></div></div>
                      }
                      @for (r of cp.rows ?? []; track r[0]) {
                        <div class="kv"><span class="k">{{ r[0] }}</span><span class="v">{{ r[1] }}</span></div>
                      }
                    }
                  </div>
                </div>
              </div>
            } @else {
              <p class="muted" style="margin-top:20px">No VPN gateway, Transit Gateway, or VPC peering found in this account/region.</p>
            }
          }
        } @else {
          <!-- ── VPC drill-down ── -->
          <button class="back-link" (click)="backToAccount()">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
            All VPCs
          </button>

          @if (detailLoading()) {
            <p class="muted">Scanning {{ selectedVpcId() }}…</p>
          } @else if (detailError()) {
            <div class="error-banner">{{ detailError() }}</div>
          } @else if (diagram(); as d) {
            <div class="canvas-shell">
              <svg #svgEl [attr.viewBox]="'0 0 ' + d.width + ' ' + d.height" preserveAspectRatio="xMidYMid meet" (click)="onCanvasBackgroundClick()">
                <g #viewport>
                  @if (d.showInternet) {
                    <g [attr.transform]="'translate(' + (d.width/2 - 16) + ',4)'">
                      <circle cx="16" cy="16" r="16" fill="#2563EB" />
                      <text x="16" y="21" text-anchor="middle" fill="#fff" font-size="13" font-weight="800">🌐</text>
                    </g>
                  }

                  @for (az of d.azs; track az.id) {
                    <rect class="az-box" [attr.x]="az.x" y="64" [attr.width]="az.w" [attr.height]="d.height - 96" rx="12" />
                    <text class="lbl" [attr.x]="az.x + 12" y="80">{{ az.label }}</text>
                  }

                  @for (sn of d.subnets; track sn.subnetId) {
                    <rect class="subnet-box" [class.public]="sn.isPublic" [class.private]="!sn.isPublic"
                          [attr.x]="sn.x" [attr.y]="sn.y" [attr.width]="sn.w" [attr.height]="sn.h" rx="10" />
                    <text class="lbl strong" [attr.x]="sn.x + 12" [attr.y]="sn.y + 20" [attr.fill]="sn.isPublic ? '#C9821A' : '#3B5FB0'">
                      {{ sn.isPublic ? 'PUBLIC' : 'PRIVATE' }}
                    </text>
                    <text class="cidr-lbl" [attr.x]="sn.x + 12" [attr.y]="sn.y + 34">{{ sn.cidr }}</text>
                  }

                  @for (edge of d.edges; track edge.key) {
                    <line class="edge-line" [class.ok]="edgeSeverity(edge.edge) === 'ok'" [class.warn]="edgeSeverity(edge.edge) === 'warn'" [class.bad]="edgeSeverity(edge.edge) === 'bad'"
                          [attr.x1]="edge.x1" [attr.y1]="edge.y1" [attr.x2]="edge.x2" [attr.y2]="edge.y2" />
                    <line class="edge-hit" [attr.x1]="edge.x1" [attr.y1]="edge.y1" [attr.x2]="edge.x2" [attr.y2]="edge.y2"
                          (click)="selectConnection(edge, $event)" />
                    <text class="edge-count" [class.warn]="edgeSeverity(edge.edge) === 'warn'" [class.bad]="edgeSeverity(edge.edge) === 'bad'" [attr.x]="(edge.x1+edge.x2)/2" [attr.y]="(edge.y1+edge.y2)/2 - 4" text-anchor="middle">{{ edge.count }}×</text>
                  }

                  @for (c of d.cards; track c.id) {
                    <g class="sg-card" [class.bad]="c.severity === 'bad'" [class.warn]="c.severity === 'warn'" [class.selected]="selectedCardId() === c.id"
                       [attr.transform]="'translate(' + c.x + ',' + c.y + ')'" (click)="selectCard(c, $event)">
                      <rect class="body" x="0" y="0" [attr.width]="c.w" [attr.height]="c.h" rx="10" />
                      <circle cx="17" cy="17" r="11" [attr.fill]="c.severity === 'bad' ? '#FDECEC' : c.severity === 'warn' ? '#FFF2DD' : '#E9F8EF'" />
                      <text x="17" y="21" text-anchor="middle" font-size="11" [attr.fill]="c.severity === 'bad' ? '#d6344c' : c.severity === 'warn' ? '#c9821a' : '#1c8a53'">⛨</text>
                      <text class="name" x="32" y="15">{{ truncate(c.card.name, 15) }}</text>
                      <text class="count" x="32" y="28">{{ c.card.resources.length }} resource{{ c.card.resources.length === 1 ? '' : 's' }}</text>
                      @if (c.severity === 'bad') {
                        <text class="flag-bad" x="10" [attr.y]="c.h - 8">{{ inboundOpenCount(c.card) }} inbound open{{ outboundOpenCount(c.card) ? ' · ' + outboundOpenCount(c.card) + ' outbound' : '' }}</text>
                      } @else if (c.severity === 'warn') {
                        <text class="flag-warn" x="10" [attr.y]="c.h - 8">{{ outboundOpenCount(c.card) }} outbound open (default)</text>
                      }
                    </g>
                  }

                  @for (be of d.badgeEdges; track be.x1 + '-' + be.y1 + '-' + be.x2 + '-' + be.y2) {
                    <line class="conn-edge" [class.vpn]="be.kind==='onprem'" [class.tgw]="be.kind==='tgw'" [class.peer]="be.kind==='peer'"
                          [attr.x1]="be.x1" [attr.y1]="be.y1" [attr.x2]="be.x2" [attr.y2]="be.y2" />
                  }
                  @for (b of d.badges; track b.id) {
                    <g class="icon-badge" [attr.transform]="'translate(' + (b.x-b.size/2) + ',' + (b.y-b.size/2) + ')'" (click)="selectExternalBadge(b, $event)">
                      <rect [attr.width]="b.size" [attr.height]="b.size" [attr.rx]="b.size*0.18" [attr.fill]="b.color" />
                      <g [attr.transform]="'scale(' + (b.size/64) + ')'" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none" [innerHTML]="glyphHtml(b.kind)"></g>
                    </g>
                    @if (b.label) { <text class="node-ext-label" [attr.x]="b.x" [attr.y]="b.y + b.size/2 + 16" text-anchor="middle">{{ b.label }}</text> }
                  }

                  <!-- Painted last so it always sits on top of edges that might otherwise cross behind it. -->
                  <text [attr.x]="LEFT" y="50" class="lbl strong">VPC · {{ vpcDetail()!.vpcId }} ({{ vpcDetail()!.cidr }})</text>
                </g>
              </svg>

              <div class="toolbar">
                <button (click)="zoomBy(0.87)" title="Zoom out">−</button>
                <span class="zoom-readout">{{ zoomPct() }}%</span>
                <button (click)="zoomBy(1.15)" title="Zoom in">+</button>
                <button (click)="resetZoom()" title="Fit to screen">⤢</button>
                <div class="sep"></div>
                <button class="inv-btn" (click)="openInventory()" title="List every resource in this VPC">☰ Inventory</button>
                <div class="sep"></div>
                <label class="toggle">
                  <input type="checkbox" [checked]="outboundCritical()" (change)="toggleOutboundCritical($event)" />
                  flag open outbound as critical
                </label>
              </div>

              <div class="legend">
                <span class="item"><span class="swatch" style="background:#FFF3D6;border:1px solid #E3A93C"></span>public subnet</span>
                <span class="item"><span class="swatch" style="background:#DFE8FB;border:1px solid #7E98D6"></span>private subnet</span>
                <span class="item"><span class="swatch" style="background:#d6344c"></span>inbound open to internet</span>
                <span class="item"><span class="swatch" style="background:#c9821a"></span>outbound open (default-allow)</span>
                <span class="item"><span class="swatch" style="background:#475569"></span>on-prem (VPN)</span>
                <span class="item"><span class="swatch" style="background:#8C4FFF"></span>Transit GW / Peering</span>
                <span class="item">drag to pan · scroll to zoom · click a group or a line</span>
              </div>

              <div class="detail" [class.open]="panelMode() !== null">
                <div class="detail-head">
                  <div>
                    <h4>{{ panelTitle() }}</h4>
                    <p>{{ panelSubtitle() }}</p>
                  </div>
                  <button class="detail-close" (click)="closePanel()">✕</button>
                </div>
                <div class="detail-body">
                  @if (panelMode() === 'sg' && panelSg(); as sg) {
                    @for (r of sg.resources; track r.id) {
                      <div class="res-row" [class.bad]="resourceSeverity(r) === 'bad'" [class.warn]="resourceSeverity(r) === 'warn'">
                        <div class="res-icon" [style.background]="iconColor(r.kind)">{{ iconGlyph(r.kind) }}</div>
                        <div>
                          <div class="name">{{ r.name }}</div>
                          <div class="kind">{{ r.kind }}</div>
                          @for (u of r.urls; track u) { <div class="res-url">🔗 {{ u }}</div> }
                          @if (r.inboundOpen || r.outboundOpen) {
                            <div class="flags">
                              @if (r.inboundOpen) { <span class="mini-pill bad">inbound open</span> }
                              @if (r.outboundOpen) { <span class="mini-pill" [class.bad]="outboundCritical()" [class.warn]="!outboundCritical()">outbound open</span> }
                            </div>
                          }
                        </div>
                      </div>
                    }
                  }
                  @if (panelMode() === 'connection' && panelConnection(); as pc) {
                    <div class="conn-ends">{{ pc.fromLabel }} <span class="arrow">→</span> {{ pc.toLabel }}</div>
                    <p class="muted" style="margin:0 0 12px">{{ pc.edge.count }} underlying connection{{ pc.edge.count === 1 ? '' : 's' }}</p>
                    @for (rule of pc.edge.rules; track rule.label) {
                      <div class="rule-row" [class.warn]="edgeSeverity(pc.edge) === 'warn'" [class.bad]="edgeSeverity(pc.edge) === 'bad'">
                        <span>{{ rule.label }}</span>
                        <span class="count">{{ rule.count }}×</span>
                      </div>
                    }
                  }
                  @if (panelMode() === 'external' && panelExternal(); as pe) {
                    <p class="muted" style="margin:0 0 12px">{{ pe.sub }}</p>
                    @for (r of pe.rows; track r[0]) {
                      <div class="kv"><span class="k">{{ r[0] }}</span><span class="v">{{ r[1] }}</span></div>
                    }
                  }
                  @if (panelMode() === 'inventory') {
                    @for (g of inventoryGroups(); track g.id) {
                      <div class="inv-group-head">
                        <span class="dot" [class.bad]="g.severity === 'bad'" [class.warn]="g.severity === 'warn'"></span>
                        <div>
                          <div class="inv-group-name">{{ g.name }}</div>
                          <div class="inv-group-sub">{{ g.sub }} · {{ g.resources.length }} resource{{ g.resources.length === 1 ? '' : 's' }}</div>
                        </div>
                      </div>
                      @for (r of g.resources; track r.id) {
                        <div class="res-row" [class.bad]="resourceSeverity(r) === 'bad'" [class.warn]="resourceSeverity(r) === 'warn'">
                          <div class="res-icon" [style.background]="iconColor(r.kind)">{{ iconGlyph(r.kind) }}</div>
                          <div>
                            <div class="name">{{ r.name }}</div>
                            <div class="kind">{{ r.kind }}</div>
                            @for (u of r.urls; track u) { <div class="res-url">🔗 {{ u }}</div> }
                            @if (r.inboundOpen || r.outboundOpen) {
                              <div class="flags">
                                @if (r.inboundOpen) { <span class="mini-pill bad">inbound open</span> }
                                @if (r.outboundOpen) { <span class="mini-pill" [class.bad]="outboundCritical()" [class.warn]="!outboundCritical()">outbound open</span> }
                              </div>
                            }
                          </div>
                        </div>
                      }
                    }
                  }
                </div>
              </div>
            </div>
          }
        }
      </div>
    } @else {
      <div class="wrap muted">Loading…</div>
    }
  `,
})
export class ViewNetworkMapComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly svc = inject(NetworkMapService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly accountTab = signal<'vpcs' | 'connectivity'>('vpcs');
  protected readonly connPanelData = signal<{ title: string; sub: string; tunnels?: { customerGatewayIp: string; status: string }[]; attachments?: { name: string; vpcId: string }[]; rows?: [string, string][] } | null>(null);
  protected readonly panelExternal = signal<{ title: string; sub: string; rows: [string, string][] } | null>(null);

  protected glyphHtml(kind: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(GLYPH[kind] || '');
  }

  @ViewChild('svgEl') private svgEl?: ElementRef<SVGSVGElement>;
  @ViewChild('viewport') private viewportEl?: ElementRef<SVGGElement>;

  protected readonly LEFT = LEFT;

  protected readonly item = signal<NetworkMap | undefined>(undefined);
  protected readonly selectedVpcId = signal<string | null>(null);
  protected readonly vpcDetail = signal<VpcDetail | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);
  protected readonly outboundCritical = signal(false);

  protected readonly selectedCardId = signal<string | null>(null);
  protected readonly panelMode = signal<'sg' | 'connection' | 'inventory' | 'external' | null>(null);
  protected readonly panelSg = signal<SecurityGroupCard | null>(null);
  protected readonly panelConnection = signal<{ edge: ConnectionEdge; fromLabel: string; toLabel: string } | null>(null);

  protected readonly selectedVpcName = signal<string | null>(null);
  private pendingOpenInventory = false;

  protected readonly zoomPct = signal(100);
  private pan = { x: 0, y: 0, scale: 1 };
  private dragging = false;
  private didDrag = false;
  private dragStart = { x: 0, y: 0 };
  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.dragging) return;
    this.didDrag = true;
    this.pan.x = e.clientX - this.dragStart.x;
    this.pan.y = e.clientY - this.dragStart.y;
    this.applyTransform();
  };
  private readonly onMouseUp = () => { this.dragging = false; };
  private readonly onMouseDown = (e: MouseEvent) => {
    this.dragging = true;
    this.didDrag = false;
    this.dragStart = { x: e.clientX - this.pan.x, y: e.clientY - this.pan.y };
  };
  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.08 : 0.93;
    this.pan.scale = Math.min(2.5, Math.max(0.35, this.pan.scale * delta));
    this.applyTransform();
  };

  ngOnInit(): void {
    const id = this.route.snapshot.params['id'];
    this.svc.get(id).subscribe(i => this.item.set(i));
  }

  ngAfterViewInit(): void {
    // Pan/zoom is applied directly to the <g> transform (not through change detection) so dragging stays
    // smooth regardless of diagram size -- re-wired every time the canvas element is (re)created.
  }

  ngOnDestroy(): void {
    this.teardownCanvasListeners();
  }

  private wireCanvasListeners(): void {
    this.teardownCanvasListeners();
    const svg = this.svgEl?.nativeElement;
    if (!svg) return;
    svg.addEventListener('mousedown', this.onMouseDown);
    svg.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  private teardownCanvasListeners(): void {
    const svg = this.svgEl?.nativeElement;
    svg?.removeEventListener('mousedown', this.onMouseDown);
    svg?.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  private applyTransform(): void {
    this.viewportEl?.nativeElement.setAttribute('transform', `translate(${this.pan.x},${this.pan.y}) scale(${this.pan.scale})`);
    this.zoomPct.set(Math.round(this.pan.scale * 100));
  }

  protected zoomBy(factor: number): void {
    this.pan.scale = Math.min(2.5, Math.max(0.35, this.pan.scale * factor));
    this.applyTransform();
  }

  protected resetZoom(): void {
    this.pan = { x: 0, y: 0, scale: 1 };
    this.applyTransform();
  }

  protected selectVpc(vpc: VpcSummary): void {
    this.selectedVpcId.set(vpc.vpcId);
    this.selectedVpcName.set(vpc.name);
    this.closePanel();
    this.detailLoading.set(true);
    this.detailError.set(null);
    const it = this.item();
    if (!it) return;
    this.svc.vpcDetail(it.id, vpc.vpcId).subscribe({
      next: d => {
        this.vpcDetail.set(d);
        this.detailLoading.set(false);
        this.pan = { x: 0, y: 0, scale: 1 };
        // Canvas <svg> only exists once the diagram has data -- wire listeners on the next tick.
        setTimeout(() => { this.wireCanvasListeners(); this.applyTransform(); });
        if (this.pendingOpenInventory) { this.pendingOpenInventory = false; this.openInventory(); }
      },
      error: err => { this.detailError.set(err?.error?.message || 'Failed to load VPC detail.'); this.detailLoading.set(false); },
    });
  }

  /** The "N resources" link on an account-grid card -- jumps straight into the VPC with the inventory
   * panel already open, instead of making the user drill in and then find the Inventory button. */
  protected openVpcInventory(vpc: VpcSummary, e: Event): void {
    e.stopPropagation();
    this.pendingOpenInventory = true;
    this.selectVpc(vpc);
  }

  protected endpointCount(vpc: VpcSummary, endpoints: EndpointInfo[] | undefined): number {
    return (endpoints ?? []).filter(ep => ep.vpcId === vpc.vpcId).length;
  }

  protected jumpToVpc(vpcId: string, vpcs: VpcSummary[] | undefined, e: Event): void {
    e.stopPropagation();
    const vpc = vpcs?.find(v => v.vpcId === vpcId);
    if (vpc) this.selectVpc(vpc);
  }

  protected backToAccount(): void {
    this.teardownCanvasListeners();
    this.selectedVpcId.set(null);
    this.selectedVpcName.set(null);
    this.vpcDetail.set(null);
    this.closePanel();
  }

  /** Clicking empty canvas (not a card, not a line) closes whichever panel is open -- but not right after
   * a pan drag, which would otherwise immediately undo the click that opened a panel mid-drag release. */
  protected onCanvasBackgroundClick(): void {
    if (this.didDrag) return;
    this.closePanel();
  }

  protected toggleOutboundCritical(e: Event): void {
    this.outboundCritical.set((e.target as HTMLInputElement).checked);
  }

  // ---------------------------------------------------------------
  // Severity -- the one thing most customers care about is inbound
  // exposure (the classic attack surface). Outbound-open is AWS's
  // default-allow-all-egress on a fresh security group, so it's
  // amber ("worth knowing") rather than red ("fix this") unless the
  // viewer opts into strict egress tracking (a customer requirement).
  // ---------------------------------------------------------------
  protected resourceSeverity(r: ResourceNode): Severity {
    if (r.inboundOpen) return 'bad';
    if (r.outboundOpen) return this.outboundCritical() ? 'bad' : 'warn';
    return 'ok';
  }
  private cardSeverity(card: SecurityGroupCard): Severity {
    if (card.inboundOpen) return 'bad';
    if (card.outboundOpen) return this.outboundCritical() ? 'bad' : 'warn';
    return 'ok';
  }
  /** Same rule as resourceSeverity/cardSeverity, applied to a connection: an edge FROM the internet
   * (inbound exposure) is always critical; an edge TO the internet (outbound) is only critical once the
   * toggle is on -- a connection line and its rule breakdown must never look more alarming than the
   * resource it's drawn from. */
  protected edgeSeverity(e: ConnectionEdge): Severity {
    if (e.fromInternet) return 'bad';
    if (e.toInternet) return this.outboundCritical() ? 'bad' : 'warn';
    return 'ok';
  }
  protected inboundOpenCount(card: SecurityGroupCard): number {
    return card.resources.filter(r => r.inboundOpen).length;
  }
  protected outboundOpenCount(card: SecurityGroupCard): number {
    return card.resources.filter(r => r.outboundOpen).length;
  }

  protected iconGlyph(kind: string): string { return (ICONS[kind]?.glyph) ?? kind.slice(0, 3).toUpperCase(); }
  protected iconColor(kind: string): string { return GRP_COLOR[ICONS[kind]?.grp ?? 'compute']; }
  protected truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ---------------------------------------------------------------
  // Panel selection
  // ---------------------------------------------------------------
  protected selectCard(c: PositionedCard, e: Event): void {
    e.stopPropagation();
    this.selectedCardId.set(c.id);
    this.panelSg.set(c.card);
    this.panelConnection.set(null);
    this.panelMode.set('sg');
  }

  protected selectConnection(edge: PositionedEdge, e: Event): void {
    e.stopPropagation();
    const d = this.vpcDetail();
    if (!d) return;
    const label = (cardId: string) => {
      if (cardId === 'internet') return 'Internet';
      const meta = this.cardIndex(d).get(cardId);
      return meta ? `${meta.card.name} (${meta.subnet.cidr})` : cardId;
    };
    this.selectedCardId.set(null);
    this.panelSg.set(null);
    this.panelConnection.set({ edge: edge.edge, fromLabel: label(edge.edge.fromId), toLabel: label(edge.edge.toId) });
    this.panelMode.set('connection');
  }

  protected openInventory(): void {
    this.selectedCardId.set(null);
    this.panelMode.set('inventory');
  }

  protected closePanel(): void {
    this.panelMode.set(null);
    this.panelSg.set(null);
    this.panelConnection.set(null);
    this.panelExternal.set(null);
    this.selectedCardId.set(null);
  }

  protected panelTitle(): string {
    const mode = this.panelMode();
    if (mode === 'sg') return this.panelSg()?.name ?? '';
    if (mode === 'connection') { const pc = this.panelConnection(); return pc ? `${pc.fromLabel} → ${pc.toLabel}` : ''; }
    if (mode === 'inventory') return 'All resources';
    if (mode === 'external') return this.panelExternal()?.title ?? '';
    return '';
  }
  protected panelSubtitle(): string {
    const mode = this.panelMode();
    if (mode === 'sg') { const n = this.panelSg()?.resources.length ?? 0; return `${n} resource${n === 1 ? '' : 's'} attached`; }
    if (mode === 'connection') { const n = this.panelConnection()?.edge.count ?? 0; return `${n} connection${n === 1 ? '' : 's'}`; }
    if (mode === 'inventory') {
      const groups = this.inventoryGroups();
      const total = groups.reduce((sum, g) => sum + g.resources.length, 0);
      return `${total} resource attachment${total === 1 ? '' : 's'} across ${groups.length} security group${groups.length === 1 ? '' : 's'}`;
    }
    if (mode === 'external') return '';
    return '';
  }

  /** Clicking an on-prem/TGW/peering pseudo-node on the VPC canvas -- a quick "why does this subnet reach
   * outside the VPC" answer. The full gateway/attachment detail (tunnel status, every attached VPC) lives
   * one level up, in the account's Connectivity tab -- this stays intentionally simple. */
  protected selectExternalBadge(b: PositionedBadge, e: Event): void {
    e.stopPropagation();
    this.selectedCardId.set(null);
    this.panelSg.set(null);
    this.panelConnection.set(null);
    const rows: [string, string][] = [['Target', b.id]];
    if (b.kind === 'onprem') rows.push(['Path', 'Subnet route table → Virtual Private Gateway → on-premises network']);
    if (b.kind === 'tgw') rows.push(['Path', 'Subnet route table → Transit Gateway → other attached VPCs']);
    if (b.kind === 'peer') rows.push(['Path', 'Subnet route table → direct VPC Peering connection']);
    this.panelExternal.set({ title: b.label ?? b.kind, sub: `Route target ${b.id}`, rows });
    this.panelMode.set('external');
  }

  protected closeConnPanel(): void {
    this.connPanelData.set(null);
  }

  /** Clicking a node in the account-level Connectivity topology -- the full detail (tunnel status for a
   * VPN Gateway, every attached VPC for a Transit Gateway, both sides of a Peering connection). */
  protected selectConnBadge(b: PositionedBadge, e: Event): void {
    e.stopPropagation();
    const conn = this.item()?.result?.connectivity;
    const vpcs = this.item()?.result?.vpcs ?? [];
    const vpcName = (id: string) => vpcs.find(v => v.vpcId === id)?.name ?? id;

    if (b.kind === 'vpn') {
      const vgw = conn?.vpnGateways.find(g => g.id === b.id);
      this.connPanelData.set({
        title: 'Site-to-Site VPN', sub: b.id,
        tunnels: vgw?.tunnels.map(t => ({ customerGatewayIp: t.customerGatewayIp, status: t.status })) ?? [],
      });
    } else if (b.kind === 'tgw') {
      const tgw = conn?.transitGateways.find(g => g.id === b.id);
      this.connPanelData.set({
        title: 'Transit Gateway', sub: b.id,
        attachments: tgw?.attachments.map(a => ({ name: vpcName(a.vpcId), vpcId: a.vpcId })) ?? [],
      });
    } else if (b.kind === 'peer') {
      const pcx = conn?.vpcPeerings.find(p => p.id === b.id);
      this.connPanelData.set({
        title: 'VPC Peering Connection', sub: b.id,
        rows: pcx ? [
          ['Requester', `${vpcName(pcx.requesterVpcId)} (${pcx.requesterCidr})`],
          ['Accepter', `${vpcName(pcx.accepterVpcId)} (${pcx.accepterCidr})`],
          ['Status', pcx.status],
        ] : [],
      });
    } else if (b.kind === 'onprem') {
      this.connPanelData.set({ title: 'Corporate Network', sub: 'on-premises', rows: [['Reaches', 'VPN Gateway(s) shown to the right']] });
    }
  }

  /** The audit view: every security-group card in the VPC as a labeled section (same grouping the canvas
   * draws), each listing its attached resources -- grouped instead of one long flat list, since a resource
   * repeated under several near-identical EKS node groups reads as noise without the group context. */
  protected readonly inventoryGroups = computed(() => {
    const d = this.vpcDetail();
    if (!d) return [] as { id: string; name: string; sub: string; severity: Severity; resources: ResourceNode[] }[];
    this.outboundCritical();
    const groups: { id: string; name: string; sub: string; severity: Severity; resources: ResourceNode[] }[] = [];
    for (const subnet of d.subnets) {
      for (const card of subnet.securityGroups) {
        groups.push({
          id: card.id,
          name: card.name,
          sub: `${subnet.availabilityZone || '—'} · ${subnet.cidr}`,
          severity: this.cardSeverity(card),
          resources: card.resources,
        });
      }
    }
    return groups;
  });

  /** Account-level topology: on-prem (one node per unique customer gateway IP across every VPN tunnel) ->
   * VPN Gateways / Transit Gateways (one shared column; a VPC can be reached via either, independently) ->
   * VPCs, plus direct Peering edges between VPC pairs that bypass everything else. Returns null when the
   * account has none of these, so the tab can show an empty state instead of a blank canvas. */
  protected readonly connectivityDiagram = computed(() => {
    const res = this.item()?.result;
    if (!res) return null;
    const conn = res.connectivity;
    const vgws = conn?.vpnGateways ?? [];
    const tgws = conn?.transitGateways ?? [];
    const peerings = conn?.vpcPeerings ?? [];
    if (vgws.length === 0 && tgws.length === 0 && peerings.length === 0) return null;

    const X_ONPREM = 70, X_GW = 320, X_VPC = 620, VPC_W = 190, VPC_H = 64, ROW_H = 90;

    const badges: PositionedBadge[] = [];
    const onpremIps = Array.from(new Set(vgws.flatMap(g => g.tunnels.map(t => t.customerGatewayIp)).filter(Boolean)));
    const onpremY = new Map<string, number>();
    onpremIps.forEach((ip, i) => {
      const y = 60 + i * ROW_H;
      onpremY.set(ip, y);
      badges.push({ id: ip, kind: 'onprem', color: ONPREM_COLOR, x: X_ONPREM, y, size: 56, label: ip });
    });

    const gwY = new Map<string, number>();
    let gi = 0;
    vgws.forEach(g => { const y = 60 + gi * ROW_H; gi++; gwY.set(g.id, y); badges.push({ id: g.id, kind: 'vpn', color: NET_COLOR, x: X_GW, y, size: 60, label: 'Site-to-Site VPN' }); });
    tgws.forEach(g => { const y = 60 + gi * ROW_H; gi++; gwY.set(g.id, y); badges.push({ id: g.id, kind: 'tgw', color: NET_COLOR, x: X_GW, y, size: 60, label: 'Transit Gateway' }); });

    const vpcIds = new Set<string>();
    vgws.forEach(g => g.attachedVpcIds.forEach(id => vpcIds.add(id)));
    tgws.forEach(g => g.attachments.forEach(a => vpcIds.add(a.vpcId)));
    peerings.forEach(p => { vpcIds.add(p.requesterVpcId); vpcIds.add(p.accepterVpcId); });

    const vpcSummaries = res.vpcs ?? [];
    // A peered VPC isn't necessarily one this account/region scan found (cross-account/cross-region
    // peering, or simply a VPC the scope can't see) -- fall back to the peering's own CIDR so the box still
    // shows something useful instead of a blank line.
    const peerCidrFor = (id: string) =>
      peerings.find(p => p.requesterVpcId === id)?.requesterCidr ?? peerings.find(p => p.accepterVpcId === id)?.accepterCidr;
    const vpcY = new Map<string, number>();
    const vpcBoxes: { id: string; name: string; cidr: string; via: string; risk: Severity; x: number; y: number; w: number; h: number }[] = [];
    let vi = 0;
    Array.from(vpcIds).forEach(id => {
      const vs = vpcSummaries.find(v => v.vpcId === id);
      const y = 50 + vi * (ROW_H - 10); vi++;
      vpcY.set(id, y);
      const via: string[] = [];
      if (vgws.some(g => g.attachedVpcIds.includes(id))) via.push('VPN');
      if (tgws.some(g => g.attachments.some(a => a.vpcId === id))) via.push('Transit Gateway');
      if (peerings.some(p => p.requesterVpcId === id || p.accepterVpcId === id)) via.push('Peering');
      const risk: Severity = vs ? (vs.inboundOpenSecurityGroupCount > 0 ? 'bad' : vs.outboundOpenSecurityGroupCount > 0 ? 'warn' : 'ok') : 'ok';
      vpcBoxes.push({ id, name: vs?.name ?? id, cidr: vs?.cidr ?? peerCidrFor(id) ?? '', via: via.join(' + ') || 'unknown', risk, x: X_VPC, y, w: VPC_W, h: VPC_H });
    });

    const edges: BadgeEdge[] = [];
    const edgeLabels: { x: number; y: number; text: string }[] = [];
    vgws.forEach(g => {
      const gy = gwY.get(g.id)!;
      Array.from(new Set(g.tunnels.map(t => t.customerGatewayIp))).forEach(ip => {
        const oy = onpremY.get(ip);
        if (oy !== undefined) edges.push({ x1: X_ONPREM + 28, y1: oy, x2: X_GW - 30, y2: gy, kind: 'vpn' });
      });
      const up = g.tunnels.filter(t => t.status === 'UP').length;
      if (g.tunnels.length > 0) edgeLabels.push({ x: (X_ONPREM + X_GW) / 2, y: gy - 10, text: `${up}/${g.tunnels.length} tunnels up` });
      g.attachedVpcIds.forEach(vid => { const vy = vpcY.get(vid); if (vy !== undefined) edges.push({ x1: X_GW + 30, y1: gy, x2: X_VPC - 10, y2: vy + VPC_H / 2, kind: 'vpn' }); });
    });
    tgws.forEach(g => {
      const gy = gwY.get(g.id)!;
      g.attachments.forEach(a => { const vy = vpcY.get(a.vpcId); if (vy !== undefined) edges.push({ x1: X_GW + 30, y1: gy, x2: X_VPC - 10, y2: vy + VPC_H / 2, kind: 'tgw' }); });
    });
    peerings.forEach(p => {
      const y1 = vpcY.get(p.requesterVpcId), y2 = vpcY.get(p.accepterVpcId);
      if (y1 === undefined || y2 === undefined) return;
      const midY = (y1 + y2) / 2 + VPC_H / 2, bowX = X_VPC + VPC_W + 60;
      edges.push({ x1: X_VPC + VPC_W, y1: y1 + VPC_H / 2, x2: bowX, y2: midY, kind: 'peer' });
      edges.push({ x1: bowX, y1: midY, x2: X_VPC + VPC_W, y2: y2 + VPC_H / 2, kind: 'peer' });
    });

    const width = X_VPC + VPC_W + 100;
    const height = Math.max(onpremIps.length, gi, vi, 1) * ROW_H + 60;
    return { width, height, badges, vpcBoxes, edges, edgeLabels };
  });

  private cardIndex(d: VpcDetail): Map<string, CardMeta> {
    const idx = new Map<string, CardMeta>();
    for (const subnet of d.subnets) for (const card of subnet.securityGroups) idx.set(card.id, { card, subnet });
    return idx;
  }

  /** Pure client-side layout: AZ columns, subnet boxes stacked within each (public first), security-group
   * cards wrapped in a grid within their subnet, and card-to-card edges drawn center-to-center (cards are
   * rendered on top of edges, so the overlap at each end is hidden under the opaque card). Recomputes
   * whenever a new VpcDetail or the outbound-severity toggle changes -- no server-side coordinates. */
  protected readonly diagram = computed(() => {
    const d = this.vpcDetail();
    if (!d) return null;
    this.outboundCritical(); // re-run when the toggle flips, to recolor severities

    const azIds = Array.from(new Set(d.subnets.map(s => s.availabilityZone || '—'))).sort();
    const azs: PositionedAz[] = [];
    const subnets: PositionedSubnet[] = [];
    const cards: PositionedCard[] = [];
    const nodePos = new Map<string, { x: number; y: number; w: number; h: number }>();
    let maxBottom = TOP;

    azIds.forEach((azId, azi) => {
      const azX = LEFT + azi * (AZ_W + AZ_GAP);
      const azSubnets = d.subnets.filter(s => (s.availabilityZone || '—') === azId).sort((a, b) => (a.isPublic === b.isPublic ? 0 : a.isPublic ? -1 : 1));

      let y = TOP;
      for (const sn of azSubnets) {
        const rows = Math.max(1, Math.ceil(sn.securityGroups.length / CARDS_PER_ROW));
        const h = SUB_PAD_TOP + rows * (SG_H + SG_ROW_GAP) - SG_ROW_GAP + 16;
        subnets.push({ subnetId: sn.subnetId, cidr: sn.cidr, isPublic: sn.isPublic, x: azX, y, w: AZ_W - SUB_PAD_X * 2, h, externalRouteTargets: sn.externalRouteTargets ?? [] });

        sn.securityGroups.forEach((card, gi) => {
          const row = Math.floor(gi / CARDS_PER_ROW), col = gi % CARDS_PER_ROW;
          const cx = azX + SUB_PAD_X + col * (SG_W + SG_GAP);
          const cy = y + SUB_PAD_TOP + row * (SG_H + SG_ROW_GAP);
          cards.push({ id: card.id, card, x: cx, y: cy, w: SG_W, h: SG_H, severity: this.cardSeverity(card) });
          nodePos.set(card.id, { x: cx, y: cy, w: SG_W, h: SG_H });
        });

        y += h + SUB_GAP;
      }
      maxBottom = Math.max(maxBottom, y);
      azs.push({ id: azId, x: azX, w: AZ_W - SUB_PAD_X, label: azId.toUpperCase() });
    });

    const contentWidth = azIds.length > 0 ? LEFT + azIds.length * (AZ_W + AZ_GAP) : 600;
    const width = contentWidth + RIGHT_MARGIN;
    const height = maxBottom + 24;
    const internetPos = { x: width / 2, y: INTERNET_Y + 16, w: 0, h: 0 };

    const edges: PositionedEdge[] = [];
    let anyInternet = false;
    for (const e of d.connections) {
      const fromInternet = e.fromId === 'internet';
      const toInternet = e.toId === 'internet';
      const from = fromInternet ? internetPos : nodePos.get(e.fromId);
      const to = toInternet ? internetPos : nodePos.get(e.toId);
      if (!from || !to) continue;
      const fromC = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
      const toC = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
      if (fromInternet || toInternet) anyInternet = true;
      edges.push({ key: `${e.fromId}->${e.toId}`, x1: fromC.x, y1: fromC.y, x2: toC.x, y2: toC.y, internet: fromInternet || toInternet, count: e.count, edge: e });
    }

    // on-prem/Transit-Gateway/Peering pseudo-nodes -- same trick as the internet globe above, but driven by
    // route-table targets instead of security-group rules. One badge per target TYPE (not per route), with
    // an edge from the badge to every subnet whose route table actually points there.
    const onpremYs: number[] = [], tgwYs: number[] = [];
    const peerYsById = new Map<string, number[]>();
    for (const sn of subnets) {
      for (const t of sn.externalRouteTargets) {
        const midY = sn.y + sn.h / 2;
        if (t.startsWith('vgw-')) onpremYs.push(midY);
        else if (t.startsWith('tgw-')) tgwYs.push(midY);
        else if (t.startsWith('pcx-')) { const arr = peerYsById.get(t) ?? []; arr.push(midY); peerYsById.set(t, arr); }
      }
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const badges: PositionedBadge[] = [];
    let onpremBadge: PositionedBadge | null = null, tgwBadge: PositionedBadge | null = null;
    const peerBadges = new Map<string, PositionedBadge>();
    if (onpremYs.length) { onpremBadge = { id: 'onprem', kind: 'onprem', color: ONPREM_COLOR, x: 60, y: avg(onpremYs), size: 56, label: 'on-prem' }; badges.push(onpremBadge); }
    if (tgwYs.length) { tgwBadge = { id: 'tgw', kind: 'tgw', color: NET_COLOR, x: width - 70, y: avg(tgwYs), size: 60, label: 'Transit GW' }; badges.push(tgwBadge); }
    let peerI = 0;
    for (const [pcxId, ys] of peerYsById) {
      const b: PositionedBadge = { id: pcxId, kind: 'peer', color: NET_COLOR, x: width - 70, y: avg(ys) + (tgwYs.length ? 110 : 0) + peerI * 110, size: 56, label: 'Peered VPC' };
      peerBadges.set(pcxId, b); badges.push(b); peerI++;
    }
    const badgeEdges: BadgeEdge[] = [];
    for (const sn of subnets) {
      for (const t of sn.externalRouteTargets) {
        if (t.startsWith('vgw-') && onpremBadge) badgeEdges.push({ x1: onpremBadge.x, y1: onpremBadge.y, x2: sn.x, y2: sn.y + sn.h / 2, kind: 'onprem' });
        else if (t.startsWith('tgw-') && tgwBadge) badgeEdges.push({ x1: tgwBadge.x, y1: tgwBadge.y, x2: sn.x + sn.w, y2: sn.y + sn.h / 2, kind: 'tgw' });
        else if (t.startsWith('pcx-')) { const b = peerBadges.get(t); if (b) badgeEdges.push({ x1: b.x, y1: b.y, x2: sn.x + sn.w, y2: sn.y + sn.h / 2, kind: 'peer' }); }
      }
    }

    return { width, height, azs, subnets, cards, edges, showInternet: anyInternet, badges, badgeEdges };
  });
}
