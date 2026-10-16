import { Component, DestroyRef, LOCALE_ID, OnInit, computed, inject, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { CapabilityState, NetworkBlueprint, NetworkGraph, SnapshotHeader } from '../model/api-types';
import { GraphIndex } from '../model/graph-index';
import { kindInfo } from '../model/kinds';
import { dnsData, egressRows, findingRows, flowLogRows, hubRows, inventoryRows, peeringRows, vpnRows } from '../model/tables';
import { MapSelection, NetworkMapComponent } from '../map/network-map.component';
import { NetworkBlueprintService } from '../network-blueprint.service';
import { IconSpriteComponent } from '../shared/icon-sprite.component';
import { NmColumn, NmTableComponent } from '../shared/nm-table.component';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { InventoryTabComponent } from './inventory-tab.component';

type Tab = 'map' | 'inventory' | 'egress' | 'vpn' | 'transit' | 'peering' | 'dns' | 'flowlogs' | 'findings' | 'snapshots';

const TABS: { id: Tab; label: string }[] = [
  { id: 'map', label: 'Map' }, { id: 'inventory', label: 'Inventory' }, { id: 'egress', label: 'Egress' },
  { id: 'vpn', label: 'S2S VPN' }, { id: 'transit', label: 'Transit' }, { id: 'peering', label: 'Peering' },
  { id: 'dns', label: 'DNS' }, { id: 'flowlogs', label: 'Flow logs' }, { id: 'findings', label: 'Findings' },
  { id: 'snapshots', label: 'Snapshots' },
];

const CAPS: { key: string; label: string; tab: Tab }[] = [
  { key: 'egress', label: 'Egress', tab: 'egress' }, { key: 'vpn', label: 'S2S VPN', tab: 'vpn' },
  { key: 'transit', label: 'Transit', tab: 'transit' }, { key: 'peering', label: 'Peering', tab: 'peering' },
  { key: 'inspection', label: 'Inspection', tab: 'map' }, { key: 'dns', label: 'DNS', tab: 'dns' },
  { key: 'flowLogs', label: 'Flow logs', tab: 'flowlogs' }, { key: 'dnsQueryLogs', label: 'DNS query logs', tab: 'dns' },
];

const COLS: Record<string, NmColumn[]> = {
  egress: [
    { key: 'network', label: 'Network' }, { key: 'subnet', label: 'Subnet' }, { key: 'cidr', label: 'CIDR', mono: true },
    { key: 'az', label: 'AZ', mono: true }, { key: 'egressText', label: '0.0.0.0/0 goes' }, { key: 'target', label: 'Target' },
    { key: 'publicIps', label: 'Public IPs', mono: true }, { key: 'severity', label: '', badge: true },
  ],
  vpn: [
    { key: 'name', label: 'Connection' }, { key: 'state', label: 'State', badge: true }, { key: 'routing', label: 'Routing' },
    { key: 'tunnels', label: 'Tunnels' }, { key: 'tunnelDetail', label: 'Tunnel detail', mono: true },
    { key: 'customerGateway', label: 'Customer gateway' }, { key: 'cgwIp', label: 'CGW IP', mono: true },
    { key: 'bgpAsn', label: 'ASN', mono: true }, { key: 'attachedTo', label: 'Attached to' }, { key: 'staticRoutes', label: 'Static routes', mono: true },
  ],
  transit: [
    { key: 'name', label: 'Hub' }, { key: 'owner', label: 'Owner', mono: true }, { key: 'visibility', label: 'Visibility', badge: true },
    { key: 'attachments', label: 'Attachments' }, { key: 'routeTables', label: 'Route tables' }, { key: 'blackholes', label: 'Blackholes' },
    { key: 'truncatedText', label: 'Routes' },
  ],
  peering: [
    { key: 'name', label: 'Peering' }, { key: 'status', label: 'Status', badge: true },
    { key: 'requester', label: 'Requester', mono: true }, { key: 'accepter', label: 'Accepter', mono: true },
  ],
  zones: [
    { key: 'name', label: 'Zone' }, { key: 'private', label: 'Type', badge: true }, { key: 'records', label: 'Records' }, { key: 'networks', label: 'Networks' },
  ],
  rules: [{ key: 'name', label: 'Resolver rule' }, { key: 'domain', label: 'Domain', mono: true }, { key: 'targets', label: 'Forwards to', mono: true }, { key: 'networks', label: 'Networks' }],
  endpoints: [{ key: 'name', label: 'Resolver endpoint' }, { key: 'direction', label: 'Direction' }, { key: 'network', label: 'Network' }],
  flowlogs: [{ key: 'network', label: 'Network' }, { key: 'coverage', label: 'Coverage', badge: true }, { key: 'destinations', label: 'Destinations', mono: true }],
  findings: [{ key: 'severity', label: 'Severity', badge: true }, { key: 'ruleId', label: 'Rule', mono: true }, { key: 'message', label: 'Finding' }, { key: 'resources', label: 'Resources' }],
  snapshots: [
    { key: 'seq', label: '#' }, { key: 'trigger', label: 'Trigger' }, { key: 'scanStatus', label: 'Status', badge: true },
    { key: 'started', label: 'Started' }, { key: 'duration', label: 'Duration' }, { key: 'nodes', label: 'Resources' }, { key: 'problems', label: 'Problems' },
  ],
  units: [
    { key: 'collector', label: 'Collector', mono: true }, { key: 'scopeId', label: 'Scope', mono: true }, { key: 'region', label: 'Region', mono: true },
    { key: 'status', label: 'Status', badge: true }, { key: 'attempts', label: 'Attempts' }, { key: 'detail', label: 'Detail' },
  ],
};

@Component({
  selector: 'nm-detail',
  imports: [CommonLibComponentsModule, StatusBadgeComponent, IconSpriteComponent, NetworkMapComponent, NmTableComponent, InventoryTabComponent],
  styleUrl: '../shared/detail-page.scss',
  styles: [`
    .nm-progress { margin: 12px 0; padding: 10px 14px; border-radius: 10px; background: #eef8f9; border: 1px solid #c8e9ed; color: #096570; font-size: .85rem; }
    .nm-progress .top { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .nm-progress .now { font-weight: 700; }
    .nm-progress .when { color: #4d8d95; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .nm-progress .bar { position: relative; height: 6px; background: #d5eef1; border-radius: 3px; margin: 8px 0; overflow: hidden; }
    .nm-progress .bar > div { height: 6px; border-radius: 3px; transition: width .6s ease; background: repeating-linear-gradient(45deg, #0d8f9e 0 10px, #19a9b9 10px 20px); background-size: 28px 28px; animation: nm-stripe 1s linear infinite; }
    .nm-progress .bar.queued > div { width: 30% !important; position: absolute; animation: nm-slide 1.4s ease-in-out infinite; }
    @keyframes nm-stripe { to { background-position: 28px 0; } }
    @keyframes nm-slide { 0% { left: -30%; } 100% { left: 100%; } }
    .nm-steps { display: flex; flex-wrap: wrap; gap: 4px 6px; }
    .nm-step { font-size: .74rem; border-radius: 1rem; padding: 1px 8px; background: #fff; border: 1px solid #d5eef1; color: #6e8d92; white-space: nowrap; }
    .nm-step.done { color: #1d7a3e; border-color: #bfe5cc; }
    .nm-step.failed, .nm-step.denied { color: #b42318; border-color: #f3c7c3; }
    .nm-step.current { color: #096570; border-color: #0d8f9e; font-weight: 700; animation: nm-pulse 1.2s ease-in-out infinite; }
    @keyframes nm-pulse { 50% { background: #d5eef1; } }
    @media (prefers-reduced-motion: reduce) { .nm-progress .bar > div, .nm-step.current { animation: none; } }
    .nm-caps { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 6px; margin: 12px 0; }
    @media (max-width: 1100px) { .nm-caps { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .nm-cap { border: 1px solid #ebe9f1; border-radius: 8px; padding: 6px 8px; cursor: pointer; background: #fff; min-width: 0; }
    .nm-cap .r { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nm-cap .t { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: #6e6b7b; font-weight: 600; }
    .nm-cap .s { font-weight: 700; font-size: .9rem; }
    .nm-cap .s.available { color: #1d7a3e; } .nm-cap .s.partial { color: #9a5b0c; } .nm-cap .s.not-readable { color: #b42318; } .nm-cap .s.none { color: #8a8797; }
    .nm-cap .r { font-size: .75rem; color: #6e6b7b; line-height: 1.3; margin-top: 2px; }
    .nm-tabs { display: flex; gap: 2px; border-bottom: 1px solid #ebe9f1; flex-wrap: wrap; margin-bottom: 12px; }
    .nm-tabs button { border: 0; background: none; padding: 8px 12px; color: #6e6b7b; font-weight: 600; font-size: .85rem; border-bottom: 2px solid transparent; cursor: pointer; }
    .nm-tabs button.active { color: #2563eb; border-bottom-color: #2563eb; }
    .nm-chip { display: inline-block; font-size: .72rem; background: #eef1f4; color: #4a5560; border-radius: 1rem; padding: .05rem .5rem; margin-right: .25rem; }
    .nm-banner { margin: 8px 0; }
    .nm-body { display: flex; gap: 12px; align-items: flex-start; }
    .nm-main { flex: 1 1 auto; min-width: 0; }
    .nm-side { flex: 0 0 340px; max-height: 720px; overflow: auto; border: 1px solid #ebe9f1; border-radius: 10px; background: #fff; padding: 12px; }
    .nm-side h4 { font-size: 1rem; margin: 0 0 2px; }
    .nm-side .sub { color: #8a8797; font-size: .8rem; margin-bottom: 10px; word-break: break-all; }
    .nm-kv { display: grid; grid-template-columns: 110px 1fr; gap: 4px 8px; font-size: .8rem; margin-bottom: 10px; }
    .nm-kv .k { color: #8a8797; } .nm-kv .v { word-break: break-all; font-family: ui-monospace, monospace; }
    .nm-side pre { font-size: .72rem; background: #f6f7f9; border-radius: 6px; padding: 8px; max-height: 280px; overflow: auto; }
    .nm-side .x { float: right; cursor: pointer; color: #8a8797; }
    .nm-sec-h { font-weight: 700; font-size: .85rem; margin: 12px 0 6px; }
  `],
  template: `
    <nm-icon-sprite />
    @if (item(); as it) {
      <div class="ext-detail-page">
        <header class="g-head">
          <span class="g-tile-ic"><i data-feather="share-2" size="26"></i></span>
          <div class="g-head-main">
            <div class="g-head-t">
              <h1>{{ it.name }}</h1>
              <app-status-badge [status]="it.status"></app-status-badge>
              @if (scanInFlight()) { <span class="dots-loader text-warning"><span></span><span></span><span></span></span> }
            </div>
            <div class="g-meta">
              @if (it.spec?.purpose) { <span class="g-meta-item">{{ it.spec.purpose }}</span><span class="sep">·</span> }
              <span class="g-meta-item">{{ memberSummary() }}</span>
              @if (latest(); as s) {
                <span class="sep">·</span>
                <span class="g-meta-item"><span class="k">Last scan:</span> {{ s.status }} · {{ fmt(s.finishedAt) }}</span>
              }
            </div>
            <div class="mt-50">@for (l of labels(); track l) { <span class="nm-chip">{{ l }}</span> }</div>
          </div>
          <div class="g-actions">
            <button type="button" class="btn btn-sm btn-primary mr-50" [disabled]="scanInFlight() || scanning()" (click)="scanNow()">⟳ Scan now</button>
            <div ngbDropdown container="body" placement="bottom-right">
              <button type="button" class="btn btn-sm hide-arrow" aria-label="More actions" ngbDropdownToggle><i data-feather="more-vertical"></i></button>
              <div ngbDropdownMenu>
                <a ngbDropdownItem (click)="edit()"><i data-feather="edit" class="mr-50"></i> Edit</a>
                <div class="dropdown-divider"></div>
                <a ngbDropdownItem class="text-danger" (click)="remove()"><i data-feather="trash-2" class="mr-50"></i> Delete</a>
              </div>
            </div>
          </div>
        </header>

        @if (progress(); as p) {
          <div class="nm-progress" role="status" aria-live="polite">
            <div class="top">
              <span class="now">{{ p.headline }}</span>
              <span class="when">{{ p.counter }} · {{ elapsed() }}</span>
            </div>
            <div class="bar" [class.queued]="p.queued"><div [style.width.%]="p.pct"></div></div>
            @if (p.steps.length) {
              <div class="nm-steps">
                @for (st of p.steps; track st.id) { <span class="nm-step" [class]="'nm-step ' + st.cls" [title]="st.title">{{ st.icon }} {{ st.label }}</span> }
              </div>
            } @else {
              <div class="small">{{ p.queued ? 'Waiting for the scan worker — it checks for work about once a minute.' : 'Collecting…' }}</div>
            }
          </div>
        }
        @if (it.result?.lastError) { <div class="alert alert-warning p-1 nm-banner">Last scan error: {{ it.result.lastError }}</div> }
        @for (m of problemMembers(); track m.networkId + m.region) {
          <div class="alert alert-warning p-1 nm-banner"><strong>{{ m.networkId }}</strong> ({{ m.region }}): {{ m.status }} — {{ m.message }}</div>
        }
        @if (latest()?.unitProblems?.length) {
          <details class="nm-banner"><summary class="text-warning">{{ latest()!.unitProblems.length }} collection problem(s) — the scan is {{ latest()!.status }}</summary>
            <ul class="mb-0">@for (p of latest()!.unitProblems; track p) { <li class="small">{{ p }}</li> }</ul>
          </details>
        }

        <div class="nm-caps">
          @for (c of capTiles(); track c.key) {
            <div class="nm-cap" [title]="c.state.reason" (click)="tab.set(c.tab)">
              <div class="t">{{ c.label }}</div>
              <div class="s" [class]="'s ' + c.state.state">● {{ c.state.state }}</div>
              <div class="r">{{ c.state.reason }}</div>
            </div>
          }
        </div>

        <div class="nm-tabs">
          @for (t of tabs; track t.id) {
            <button type="button" [class.active]="tab() === t.id" (click)="openTab(t.id)">{{ t.label }}@if (t.id === 'findings' && findings().length) { ({{ findings().length }}) }</button>
          }
        </div>

        @if (!graph() && !graphError()) {
          <p class="text-muted">{{ it.result?.latestSnapshotId ? 'Loading the latest snapshot…' : 'No snapshot yet — the first scan is running.' }}</p>
        }
        @if (graphError()) { <div class="alert alert-danger p-1">{{ graphError() }}</div> }

        <div class="nm-body">
          <div class="nm-main">
            @switch (tab()) {
              @case ('map') { <nm-network-map [graph]="graph()" [reveal]="reveal()" (selected)="selection.set($event)" /> }
              @case ('inventory') { <nm-inventory-tab [rows]="inventory()" [fileName]="it.name + '-inventory'" (rowClick)="selectNode({ id: $event })" /> }
              @case ('egress') { <nm-table [columns]="cols['egress']" [rows]="egress()" [clickable]="true" empty="No member subnets collected." (rowClick)="selectNode($event)" /> }
              @case ('vpn') { <nm-table [columns]="cols['vpn']" [rows]="vpn()" [clickable]="true" empty="No site-to-site VPN connections reach these networks." (rowClick)="selectNode($event)" /> }
              @case ('transit') { <nm-table [columns]="cols['transit']" [rows]="transit()" [clickable]="true" empty="No transit hubs attached." (rowClick)="selectNode($event)" /> }
              @case ('peering') { <nm-table [columns]="cols['peering']" [rows]="peering()" [clickable]="true" empty="No VPC peering on these networks." (rowClick)="selectNode($event)" /> }
              @case ('dns') {
                <div class="nm-sec-h">Hosted zones</div>
                <nm-table [columns]="cols['zones']" [rows]="dns().zones" [clickable]="true" empty="No hosted zones point at or are associated with these networks." (rowClick)="selectNode($event)" />
                <div class="nm-sec-h">Resolver rules</div>
                <nm-table [columns]="cols['rules']" [rows]="dns().rules" [clickable]="true" empty="No resolver rules." (rowClick)="selectNode($event)" />
                <div class="nm-sec-h">Resolver endpoints</div>
                <nm-table [columns]="cols['endpoints']" [rows]="dns().endpoints" [clickable]="true" empty="No resolver endpoints." (rowClick)="selectNode($event)" />
              }
              @case ('flowlogs') { <nm-table [columns]="cols['flowlogs']" [rows]="flowLogs()" [clickable]="true" empty="No member networks collected." (rowClick)="selectNode($event)" /> }
              @case ('findings') { <nm-table [columns]="cols['findings']" [rows]="findings()" empty="No findings." /> }
              @case ('snapshots') {
                <nm-table [columns]="cols['snapshots']" [rows]="snapshotRows()" [clickable]="true" empty="No snapshots yet." (rowClick)="selectedSnapshot.set($event['id'])" />
                @if (unitRows().length) {
                  <div class="nm-sec-h">Work units of the selected snapshot</div>
                  <nm-table [columns]="cols['units']" [rows]="unitRows()" />
                }
              }
            }
          </div>

          @if (panel(); as p) {
            <aside class="nm-side">
              <span class="x" title="Close" (click)="selection.set(null)">✕</span>
              <h4>{{ p.title }}</h4>
              <div class="sub">{{ p.sub }}</div>
              @if (p.rows.length) { <div class="nm-kv">@for (r of p.rows; track r[0]) { <span class="k">{{ r[0] }}</span><span class="v">{{ r[1] }}</span> }</div> }
              @if (p.list.length) { <ul class="small pl-1">@for (l of p.list; track l) { <li>{{ l }}</li> }</ul> }
              @if (p.raw) { <details><summary class="small">Raw (sanitized)</summary><pre>{{ p.raw }}</pre></details> }
            </aside>
          }
        </div>
      </div>
    } @else if (loadError()) {
      <div class="alert alert-danger p-1">{{ loadError() }}</div>
    } @else {
      <div class="card p-2 text-muted">Loading…</div>
    }
  `,
})
export class BlueprintDetailComponent implements OnInit {
  private readonly svc = inject(NetworkBlueprintService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);
  private readonly id: string = this.route.snapshot.params['id'];
  private poll?: Subscription;
  private loadedSnapshotId: string | null = null;

  protected readonly tabs = TABS;
  protected readonly cols = COLS;
  protected readonly item = signal<NetworkBlueprint | null>(null);
  protected readonly loadError = signal('');
  protected readonly graph = signal<NetworkGraph | null>(null);
  protected readonly graphError = signal('');
  protected readonly tab = signal<Tab>('map');
  protected readonly selection = signal<MapSelection | null>(null);
  protected readonly scanning = signal(false);
  protected readonly snapshots = signal<SnapshotHeader[]>([]);
  protected readonly selectedSnapshot = signal<string | null>(null);

  private readonly awaiting = signal(false);
  private readonly now = signal(Date.now());
  private clock?: Subscription;
  /** A scan is requested or running: the server shows activeScan, or no snapshot exists yet, or Scan now was just clicked. */
  protected readonly scanInFlight = computed(() => {
    const r = this.item()?.result;
    return !!r?.activeScan || (!r?.latestSnapshotId && !r?.lastError) || this.awaiting();
  });
  private readonly runningSnapshot = computed(() => {
    const a = this.item()?.result?.activeScan;
    return a ? this.snapshots().find(s => s.id === a.snapshotId) ?? null : null;
  });
  protected readonly progress = computed(() => {
    if (!this.scanInFlight()) return null;
    const a = this.item()?.result?.activeScan;
    if (!a) return { queued: true, headline: 'Scan queued', counter: 'starting', pct: 0, steps: [] as Step[] };
    const current = a.currentUnit ? describeUnit(a.currentUnit) : '';
    const units = [...(this.runningSnapshot()?.units ?? [])].sort((x, y) => (COLLECTOR_ORDER[x.collector] ?? 99) - (COLLECTOR_ORDER[y.collector] ?? 99));
    const steps: Step[] = units.map(u => {
      const isCurrent = u.id === a.currentUnit && u.status === 'pending';
      const icon = u.status === 'done' ? '✓' : u.status === 'failed' || u.status === 'denied' ? '✕' : isCurrent ? '◌' : '○';
      return { id: u.id, label: `${COLLECTOR_LABEL[u.collector] ?? u.collector} · ${u.region}`, cls: isCurrent ? 'current' : u.status, icon,
        title: u.missingPermission ? `missing ${u.missingPermission}` : u.error ?? u.status };
    });
    return {
      queued: false,
      headline: current ? `Scanning ${current}` : 'Scanning…',
      counter: `${a.unitsFinished}/${a.unitsTotal} steps`,
      pct: a.unitsTotal ? Math.max(4, (100 * a.unitsFinished) / a.unitsTotal) : 4,
      steps,
    };
  });
  protected readonly elapsed = computed(() => {
    const a = this.item()?.result?.activeScan;
    const from = Date.parse(a?.startedAt ?? a?.requestedAt ?? this.item()?.spec?.scanRequestedAt ?? '') || this.openedAt;
    const s = Math.max(0, Math.round((this.now() - from) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  });
  private readonly openedAt = Date.now();

  protected readonly latest = computed(() => this.item()?.result?.latestSummary ?? null);
  private readonly idx = computed(() => (this.graph() ? new GraphIndex(this.graph()!) : null));

  protected readonly labels = computed(() => Object.entries(this.item()?.spec?.labels ?? {}).map(([k, v]) => `${k}=${v}`));
  protected readonly memberSummary = computed(() => {
    const m = this.item()?.spec?.members ?? [];
    const scopes = new Set(m.map(x => x.scopeId)).size;
    const regions = new Set(m.map(x => x.region)).size;
    return `${m.length} network${m.length === 1 ? '' : 's'} · ${scopes} scope${scopes === 1 ? '' : 's'} · ${regions} region${regions === 1 ? '' : 's'}`;
  });
  protected readonly problemMembers = computed(() => (this.item()?.result?.memberStatuses ?? []).filter(m => m.status !== 'ok'));
  protected readonly capTiles = computed(() => CAPS.map(c => ({
    ...c,
    state: (this.latest()?.capabilities?.[c.key] ?? { state: 'none', reason: 'not scanned yet', counts: {} }) as CapabilityState,
  })));

  protected readonly inventory = computed(() => (this.idx() ? inventoryRows(this.idx()!) : []));
  protected readonly egress = computed(() => (this.idx() ? egressRows(this.idx()!) : []));
  protected readonly vpn = computed(() => (this.idx() ? vpnRows(this.idx()!) : []));
  protected readonly transit = computed(() => (this.idx() ? hubRows(this.idx()!).map(r => ({ ...r, truncatedText: r.truncated ? 'truncated at 1000' : 'complete' })) : []));
  protected readonly peering = computed(() => (this.idx() ? peeringRows(this.idx()!) : []));
  protected readonly dns = computed(() => (this.idx() ? dnsData(this.idx()!) : { zones: [], rules: [], endpoints: [] }));
  protected readonly flowLogs = computed(() => (this.idx() ? flowLogRows(this.idx()!) : []));
  protected readonly findings = computed(() => (this.idx() ? findingRows(this.idx()!) : []));

  protected readonly snapshotRows = computed(() => this.snapshots().map(s => ({
    id: s.id,
    seq: `#${s.sequence}`,
    trigger: s.trigger,
    scanStatus: s.scanStatus,
    started: this.fmt(s.startedAt),
    duration: s.finishedAt ? `${Math.max(1, Math.round((Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 1000))} s` : '—',
    nodes: s.summary?.nodeCount ?? '—',
    problems: (s.summary?.unitsFailed ?? 0) + (s.summary?.unitsDenied ?? 0) || '—',
    severity: s.scanStatus === 'failed' || s.scanStatus === 'abandoned' ? 'bad' : s.scanStatus === 'partial' ? 'warn' : 'ok',
  })));
  protected readonly unitRows = computed(() => {
    const s = this.snapshots().find(x => x.id === this.selectedSnapshot());
    return (s?.units ?? []).map(u => ({
      id: u.id, collector: u.collector, scopeId: u.scopeId, region: u.region, status: u.status, attempts: u.attempts,
      detail: u.missingPermission ? `missing ${u.missingPermission}` : u.error ?? '',
      severity: u.status === 'denied' || u.status === 'failed' ? 'bad' : 'ok',
    }));
  });

  /** Side panel content for the current selection (node, VPN-site aggregate or edge). */
  protected readonly panel = computed(() => {
    const sel = this.selection();
    const idx = this.idx();
    if (!sel || !idx) return null;
    if (sel.kind === 'aggregate') {
      return { title: sel.label, sub: 'Site-to-site VPN connections', rows: [] as [string, string][], list: sel.memberIds.map(id => idx.node(id)?.name ?? id), raw: '' };
    }
    if (sel.kind === 'edge') {
      const name = (id: string) => idx.node(id)?.name ?? id.replace(/^agg:vpn-sites:/, 'VPN sites → ');
      const underlying = sel.edgeIds.slice(0, 25).map(eid => idx.graph.edges.find(e => e.id === eid)).filter(Boolean);
      return {
        title: `${name(sel.from)} → ${name(sel.to)}`,
        sub: `${sel.count} relationship${sel.count === 1 ? '' : 's'} · ${sel.kinds.join(', ')}`,
        rows: [] as [string, string][],
        list: underlying.map(e => `${e!.kind}: ${idx.node(e!.from)?.name ?? e!.from} → ${idx.node(e!.to)?.name ?? e!.to}${e!.attrs && Object.keys(e!.attrs).length ? ` (${Object.entries(e!.attrs).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')})` : ''}`),
        raw: '',
      };
    }
    const n = idx.node(sel.id);
    if (!n) return null;
    const rows: [string, string][] = [
      ['Kind', kindInfo(n.kind).label], ['Id', n.nativeId], ['Account', n.ownerAccount ?? n.account ?? '—'], ['Region', n.region ?? '—'],
      ['Visibility', n.visibility], ['Membership', n.membership], ['State', n.state ?? '—'], ['Seen from', (n.seenFrom ?? []).join(', ') || '—'],
      ...Object.entries(n.tags ?? {}).map(([k, v]) => [`tag ${k}`, v] as [string, string]),
      ...Object.entries(n.attrs ?? {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]),
    ];
    return { title: n.name, sub: n.id, rows, list: [] as string[], raw: n.raw ? JSON.stringify(n.raw, null, 2) : '' };
  });

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.svc.get(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: item => {
        const prevSnap = this.item()?.result?.latestSnapshotId ?? null;
        const prevActive = !!this.item()?.result?.activeScan;
        this.item.set(item);
        const snap = item?.result?.latestSnapshotId ?? null;
        const active = !!item?.result?.activeScan;
        // "Scan now" stays pending until the server shows the scan, then until that scan ends
        if (this.awaiting() && ((prevActive && !active) || (snap && snap !== prevSnap && !active))) this.awaiting.set(false);
        this.ensurePolling(this.scanInFlight());
        if (snap && snap !== this.loadedSnapshotId) this.loadGraph(snap);
        if (active || this.tab() === 'snapshots') this.loadSnapshots();
      },
      error: err => this.loadError.set(NetworkBlueprintService.errorMessage(err)),
    });
  }

  private loadGraph(snapshotId: string): void {
    this.loadedSnapshotId = snapshotId;
    this.graphError.set('');
    this.svc.graph(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: g => this.graph.set(g),
      error: err => this.graphError.set(NetworkBlueprintService.errorMessage(err)),
    });
  }

  private loadSnapshots(): void {
    this.svc.snapshots(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: s => this.snapshots.set(s ?? []),
      error: () => this.snapshots.set([]),
    });
  }

  /** Poll every 4 s (and tick the elapsed clock every second) while a scan is queued or running. */
  private ensurePolling(active: boolean): void {
    if (active && !this.poll) {
      this.poll = interval(4000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
      this.clock = interval(1000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.now.set(Date.now()));
    } else if (!active && this.poll) {
      this.poll.unsubscribe();
      this.clock?.unsubscribe();
      this.poll = undefined;
      this.clock = undefined;
    }
  }

  protected openTab(t: Tab): void {
    this.tab.set(t);
    if (t === 'snapshots') this.loadSnapshots();
  }

  protected readonly reveal = signal<{ id: string; seq: number } | null>(null);

  /** A row in any data tab: open it on the map (right level and focus, selected, centred) with its details alongside. */
  protected selectNode(row: Record<string, any>): void {
    const id = row['id'];
    if (!id || !this.idx()?.node(id)) return;
    this.selection.set({ kind: 'node', id });
    this.tab.set('map');
    this.reveal.set({ id, seq: (this.reveal()?.seq ?? 0) + 1 });
  }

  protected scanNow(): void {
    const it = this.item();
    if (!it) return;
    this.scanning.set(true);
    this.svc.scanNow(it).subscribe({
      next: () => {
        this.scanning.set(false);
        this.awaiting.set(true);
        this.ensurePolling(true);
        this.load();
      },
      error: err => {
        this.scanning.set(false);
        alert(NetworkBlueprintService.errorMessage(err));
      },
    });
  }

  protected edit(): void {
    this.router.navigate(['../../edit', this.id], { relativeTo: this.route });
  }

  protected remove(): void {
    const it = this.item();
    if (!it || !confirm(`Delete blueprint "${it.name}" and its snapshots? Nothing in AWS is changed.`)) return;
    this.svc.delete(this.id).subscribe({
      next: () => this.router.navigate(['../..'], { relativeTo: this.route }),
      error: err => alert(NetworkBlueprintService.errorMessage(err)),
    });
  }

  protected fmt(v: string | null | undefined): string {
    return v ? formatDate(v, 'medium', this.locale) : '—';
  }
}

interface Step { id: string; label: string; cls: string; icon: string; title: string }

const COLLECTOR_LABEL: Record<string, string> = {
  'aws.core-network': 'VPCs, subnets & routes', 'aws.interfaces': 'Interfaces & workloads', 'aws.load-balancers': 'Load balancers',
  'aws.endpoints': 'VPC endpoints', 'aws.transit': 'Transit gateways', 'aws.vpn': 'Site-to-site VPN', 'aws.peering': 'Peering',
  'aws.dns-resolver': 'DNS resolver', 'aws.flow-logs': 'Flow logs', 'aws.dns-zones': 'Route 53 zones',
};
const COLLECTOR_ORDER: Record<string, number> = Object.fromEntries(Object.keys(COLLECTOR_LABEL).map((k, i) => [k, i]));

/** Work unit ids are `collector|scopeId|region`. */
function describeUnit(id: string): string {
  const [collector, , region] = id.split('|');
  const label = COLLECTOR_LABEL[collector] ?? collector;
  return region && region !== 'global' ? `${label.toLowerCase()} in ${region}` : label.toLowerCase();
}
