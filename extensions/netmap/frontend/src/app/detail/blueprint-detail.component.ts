import { Component, DestroyRef, LOCALE_ID, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { nodeDetails } from '../model/details';
import { withoutSystemNamespaces } from '../model/layers';
import { relatedResources } from '../model/related';
import { formatDate } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { CapabilityState, NetworkBlueprint, NetworkGraph, SnapshotHeader, WorkspaceScope } from '../model/api-types';
import { GraphIndex } from '../model/graph-index';
import { kindInfo } from '../model/kinds';
import { outsideMember, scopeForAccount, specWithMember } from '../model/outside';
import { PathResult, Verdict, traceInbound, tracePath, inboundHints } from '../model/path';
import { memberKey } from '../model/picker';
import { dnsData, egressRows, findingRows, flowLogRows, hubRows, inventoryRows, peeringRows, vpnRows, workloadsData } from '../model/tables';
import { MapSelection, NetworkMapComponent } from '../map/network-map.component';
import { NetworkBlueprintService } from '../network-blueprint.service';
import { IconSpriteComponent } from '../shared/icon-sprite.component';
import { NmColumn, NmTableComponent } from '../shared/nm-table.component';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { InventoryTabComponent } from './inventory-tab.component';
import { TraceBarComponent, TraceRequest } from './trace-bar.component';

type Tab = 'map' | 'inventory' | 'egress' | 'vpn' | 'transit' | 'peering' | 'dns' | 'flowlogs' | 'workloads' | 'findings' | 'snapshots';

const TABS: { id: Tab; label: string }[] = [
  { id: 'map', label: 'Map' }, { id: 'inventory', label: 'Inventory' }, { id: 'egress', label: 'Egress' },
  { id: 'vpn', label: 'S2S VPN' }, { id: 'transit', label: 'Transit' }, { id: 'peering', label: 'Peering' },
  { id: 'dns', label: 'DNS' }, { id: 'flowlogs', label: 'Flow logs' }, { id: 'workloads', label: 'Workloads' }, { id: 'findings', label: 'Findings' },
  { id: 'snapshots', label: 'Snapshots' },
];

const CAPS: { key: string; label: string; tab: Tab }[] = [
  { key: 'egress', label: 'Egress', tab: 'egress' }, { key: 'vpn', label: 'S2S VPN', tab: 'vpn' },
  { key: 'transit', label: 'Transit', tab: 'transit' }, { key: 'peering', label: 'Peering', tab: 'peering' },
  { key: 'inspection', label: 'Inspection', tab: 'map' }, { key: 'dns', label: 'DNS', tab: 'dns' },
  { key: 'flowLogs', label: 'Flow logs', tab: 'flowlogs' }, { key: 'dnsQueryLogs', label: 'DNS query logs', tab: 'dns' },
  { key: 'workloads', label: 'Workloads', tab: 'workloads' },
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
  clusters: [
    { key: 'name', label: 'Cluster' }, { key: 'type', label: 'Type' }, { key: 'network', label: 'Network' }, { key: 'version', label: 'Version', mono: true },
    { key: 'access', label: 'Access', badge: true }, { key: 'namespaces', label: 'Namespaces' }, { key: 'pods', label: 'Pods' }, { key: 'services', label: 'Services' },
    { key: 'detail', label: 'Detail' },
  ],
  namespaces: [
    { key: 'cluster', label: 'Cluster' }, { key: 'name', label: 'Namespace' }, { key: 'pods', label: 'Pods' }, { key: 'services', label: 'Services' },
    { key: 'ingresses', label: 'Ingresses' }, { key: 'policies', label: 'Network policies' }, { key: 'severity', label: '', badge: true },
  ],
  k8sServices: [
    { key: 'cluster', label: 'Cluster' }, { key: 'namespace', label: 'Namespace' }, { key: 'name', label: 'Service' }, { key: 'type', label: 'Type' },
    { key: 'scheme', label: 'Scheme' }, { key: 'ports', label: 'Ports', mono: true }, { key: 'pods', label: 'Pods' }, { key: 'loadBalancer', label: 'Load balancer' },
  ],
  ecsServices: [
    { key: 'cluster', label: 'Cluster' }, { key: 'name', label: 'Service' }, { key: 'running', label: 'Running' }, { key: 'launchType', label: 'Launch type' },
    { key: 'loadBalancer', label: 'Load balancer' }, { key: 'publicIps', label: 'Public IPs', mono: true }, { key: 'network', label: 'Network' },
  ],
  lambdas: [
    { key: 'name', label: 'Function' }, { key: 'network', label: 'Network' }, { key: 'runtime', label: 'Runtime', mono: true }, { key: 'subnets', label: 'Subnets' },
    { key: 'egress', label: 'Subnet egress' }, { key: 'interfaces', label: 'Interfaces' }, { key: 'severity', label: '', badge: true },
  ],
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
  imports: [CommonLibComponentsModule, StatusBadgeComponent, IconSpriteComponent, NetworkMapComponent, NmTableComponent, InventoryTabComponent, TraceBarComponent],
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
    .nm-caps { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 6px; margin: 12px 0; }
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
    .nm-kv { display: grid; grid-template-columns: minmax(90px, 38%) minmax(0, 1fr); gap: 4px 8px; font-size: .8rem; margin-bottom: 10px; }
    .nm-kv .k { color: #8a8797; overflow-wrap: anywhere; min-width: 0; } .nm-kv .v { overflow-wrap: anywhere; min-width: 0; font-family: ui-monospace, monospace; }
    .nm-kv-h { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #6e6b7b; font-weight: 700; margin: 12px 0 4px; border-top: 1px solid #f0eef5; padding-top: 8px; }
    .nm-side .act { margin: 4px 0 10px; }
    .nm-outcome { border-radius: 8px; padding: 8px 10px; margin: 6px 0 10px; font-size: .85rem; font-weight: 700; }
    .nm-outcome .small { font-weight: 400; margin-top: 2px; }
    .nm-outcome.o-reaches { background: #e8f6ee; color: #1d7a3e; }
    .nm-outcome.o-blocked { background: #fdecea; color: #b42318; }
    .nm-outcome.o-unknown, .nm-outcome.o-leaves-blueprint { background: #fdf3e2; color: #9a5b0c; }
    .nm-entries { display: flex; flex-direction: column; gap: 2px; margin: 6px 0; max-height: 180px; overflow: auto; }
    .nm-entries button { text-align: left; border: 1px solid #ebe9f1; background: #fff; border-radius: 6px; padding: 4px 8px; font-size: .78rem; cursor: pointer; }
    .nm-entries button.active { border-color: #0d8f9e; background: #eef8f9; }
    .nm-hops { list-style: none; padding: 0; margin: 0; counter-reset: hop; }
    .nm-hops li { display: grid; grid-template-columns: 22px 18px minmax(0, 1fr); gap: 4px; padding: 6px 4px; border-bottom: 1px solid #f3f2f7; cursor: pointer; font-size: .8rem; }
    .nm-hops li:hover { background: #f7f9fb; }
    .nm-hops .n { color: #8a8797; font-variant-numeric: tabular-nums; text-align: right; }
    .nm-hops .vi { font-weight: 700; text-align: center; }
    .nm-hops .v-allow .vi { color: #1d7a3e; } .nm-hops .v-block .vi { color: #b42318; } .nm-hops .v-unknown .vi { color: #9a5b0c; } .nm-hops .v-info .vi { color: #8a8797; }
    .nm-hops .t { font-weight: 600; overflow-wrap: anywhere; }
    .nm-hops .r { color: #6e6b7b; overflow-wrap: anywhere; }
    .nm-hops code { display: block; margin-top: 2px; font-size: .72rem; color: #344054; background: #f6f7f9; border-radius: 4px; padding: 2px 5px; overflow-wrap: anywhere; white-space: normal; }
    .nm-outside { border: 1px dashed #d9a74a; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: .8rem; }
    .nm-outside select { margin: 6px 0; }
    .nm-side pre { font-size: .72rem; background: #f6f7f9; border-radius: 6px; padding: 8px; max-height: 280px; overflow: auto; }
    .nm-side .x { float: right; cursor: pointer; color: #8a8797; }
    .nm-sec-h { font-weight: 700; font-size: .85rem; margin: 12px 0 6px; }
    .nm-dt { width: 100%; border-collapse: collapse; font-size: .76rem; margin-bottom: 10px; table-layout: auto; }
    .nm-dt th { text-align: left; color: #8a8797; font-weight: 600; padding: 3px 4px; border-bottom: 1px solid #ebe9f1; white-space: nowrap; }
    .nm-dt td { padding: 3px 4px; border-bottom: 1px solid #f3f2f7; font-family: ui-monospace, monospace; overflow-wrap: anywhere; vertical-align: top; }
    .nm-dt tr.go { cursor: pointer; } .nm-dt tr.go:hover td { background: rgba(13, 143, 158, .07); }
    .nm-dt tr.t-bad td { color: #b42318; } .nm-dt tr.t-warn td { color: #9a5b0c; } .nm-dt tr.t-muted td { color: #8a8797; }
    .nm-line { font-size: .8rem; color: #4a5560; margin: -4px 0 8px; }
    .nm-fold { margin: 4px 0; }
    .nm-fold > summary { cursor: pointer; font-size: .8rem; font-weight: 600; color: #4a5560; list-style: none; padding: 3px 0; }
    .nm-fold > summary::-webkit-details-marker { display: none; }
    .nm-fold > summary::before { content: '›'; display: inline-block; width: 14px; transition: transform .15s; color: #8a8797; }
    .nm-fold[open] > summary::before { transform: rotate(90deg); }
    .nm-rel { list-style: none; padding: 0 0 0 14px; margin: 0 0 6px; }
    .nm-rel li { display: flex; flex-direction: column; padding: 3px 6px; border-radius: 6px; cursor: pointer; }
    .nm-rel li:hover { background: rgba(13, 143, 158, .07); }
    .nm-rel .l { font-size: .8rem; color: #0d8f9e; font-weight: 600; overflow-wrap: anywhere; }
    .nm-rel .s { font-size: .72rem; color: #8a8797; overflow-wrap: anywhere; }
    .nm-rel li.more { cursor: default; font-size: .74rem; color: #8a8797; }
    .nm-search-row { display: flex; gap: 8px; align-items: flex-start; }
    .nm-search-row nm-trace-bar { flex: 1 1 auto; min-width: 0; }
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
              @case ('map') {
                <div class="nm-search-row">
                  <nm-trace-bar [index]="idx()" [(source)]="traceSource" (picked)="onPicked($event)" (trace)="runTrace($event)" />
                  <button type="button" class="btn btn-sm btn-outline-secondary" title="Clear search, trace, selection and focus — back to L1" (click)="clearAll()">Clear</button>
                </div>
                <nm-network-map [graph]="viewGraph()" [reveal]="reveal()" [path]="activePath()" (selected)="selection.set($event)" (clearPath)="clearTrace()" />
              }
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
              @case ('workloads') {
                @let wd = workloads();
                <div class="nm-sec-h">Kubernetes clusters</div>
                <nm-table [columns]="cols['clusters']" [rows]="wd.clusters" [clickable]="true" empty="No EKS clusters in these networks." (rowClick)="selectNode($event)" />
                <div class="nm-sec-h">Namespaces</div>
                <nm-table [columns]="cols['namespaces']" [rows]="wd.namespaces" [clickable]="true" empty="No namespaces read." (rowClick)="selectNode($event)" />
                <div class="nm-sec-h">Kubernetes services</div>
                <nm-table [columns]="cols['k8sServices']" [rows]="wd.services" [clickable]="true" empty="No services read." (rowClick)="selectNode($event)" />
                <div class="nm-sec-h">ECS services</div>
                <nm-table [columns]="cols['ecsServices']" [rows]="wd.ecsServices" [clickable]="true" empty="No ECS services in these networks." (rowClick)="selectNode($event)" />
                <div class="nm-sec-h">Lambda functions (VPC)</div>
                <nm-table [columns]="cols['lambdas']" [rows]="wd.lambdas" [clickable]="true" empty="No VPC Lambda functions in these networks." (rowClick)="selectNode($event)" />
              }
              @case ('findings') { <nm-table [columns]="cols['findings']" [rows]="findings()" [clickable]="true" empty="No findings." (rowClick)="selectNode({ id: $event['nodeId'] })" /> }
              @case ('snapshots') {
                <nm-table [columns]="cols['snapshots']" [rows]="snapshotRows()" [clickable]="true" empty="No snapshots yet." (rowClick)="selectedSnapshot.set($event['id'])" />
                @if (unitRows().length) {
                  <div class="nm-sec-h">Work units of the selected snapshot</div>
                  <nm-table [columns]="cols['units']" [rows]="unitRows()" />
                }
              }
            }
          </div>

          @if (traceView(); as tv) {
            <aside class="nm-side" aria-live="polite">
              <span class="x" title="Close the trace" (click)="clearTrace()">✕</span>
              <h4>{{ tv.title }}</h4>
              <div class="sub">{{ tv.sub }}</div>
              @if (tv.entries.length > 1) {
                <div class="small text-muted">{{ tv.entries.length }} entry points</div>
                <div class="nm-entries">
                  @for (e of tv.entries; track $index) {
                    <button type="button" [class.active]="$index === tv.active" (click)="traceActive.set($index)">{{ e.icon }} {{ e.label }}</button>
                  }
                </div>
              }
              @if (tv.path; as path) {
                <div class="nm-outcome" [class]="'nm-outcome o-' + path.outcome">{{ tv.outcomeText }}<div class="small">{{ path.summary }}</div></div>
                @if (outsideInfo(); as o) {
                  <div class="nm-outside">
                    @if (o.addable) {
                      @if (o.member) {
                        <div><b>{{ o.name }}</b> is already in this blueprint — waiting for the scan that collects it.</div>
                      } @else {
                        <div>Outside this blueprint — add <b>{{ o.name }}</b> and rescan.</div>
                        <div class="small text-muted">{{ o.account ? 'Account ' + o.account + ' · ' : '' }}{{ o.region }}</div>
                        @if (!o.auto) {
                          <select class="custom-select custom-select-sm form-control-sm" [value]="outsideScope()" (change)="outsideScope.set($any($event.target).value)" aria-label="Scope that can read this network">
                            <option value="">Choose the scope that can read it…</option>
                            @for (sc of scopes(); track sc.id) { <option [value]="sc.id">{{ sc.name }}</option> }
                          </select>
                        } @else { <div class="small">Using the scope of the other members in that account.</div> }
                        <button type="button" class="btn btn-sm btn-primary mt-50" [disabled]="adding() || scanInFlight() || !(o.auto || outsideScope())" (click)="addOutside()">{{ adding() ? 'Adding…' : 'Add to blueprint and rescan' }}</button>
                      }
                    } @else {
                      <div>Leaves to <b>{{ o.name }}</b> — what happens beyond it is not visible from this blueprint.</div>
                    }
                  </div>
                }
                <ol class="nm-hops">
                  @for (h of path.hops; track $index) {
                    <li [class]="'v-' + h.verdict" (click)="revealHop(h.nodeId)" [title]="'Show on the map'">
                      <span class="n">{{ $index + 1 }}</span><span class="vi">{{ icon(h.verdict) }}</span>
                      <div><div class="t">{{ h.title }}</div><div class="r">{{ h.reason }}</div>@if (h.rule) { <code>{{ h.rule }}</code> }</div>
                    </li>
                  }
                </ol>
              } @else {
                <p class="small text-muted mt-1">No entry points into this resource were found in the graph — no public IP, load balancer, hub route, peering or VPN reaches it.</p>
                @if (inboundWhy().length) {
                  <div class="small font-weight-bold mt-50">Why</div>
                  <ul class="small pl-1 mb-0">@for (w of inboundWhy(); track w) { <li>{{ w }}</li> }</ul>
                }
              }
            </aside>
          } @else if (panel(); as p) {
            <aside class="nm-side">
              <span class="x" title="Close" (click)="selection.set(null)">✕</span>
              <h4>{{ p.title }}</h4>
              <div class="sub">{{ p.sub }}</div>
              @if (p.nodeId) { <div class="act"><button type="button" class="btn btn-sm btn-outline-primary" (click)="traceFrom(p.nodeId)">Trace path</button></div> }
              @if (p.line) { <div class="nm-line">{{ p.line }}</div> }
              @for (sec of p.sections; track sec.title) {
                <div class="nm-kv-h">{{ sec.title }}</div>
                @if (sec.rows.length) {
                  <table class="nm-dt">
                    <thead><tr>@for (c of sec.columns; track c) { <th>{{ c }}</th> }</tr></thead>
                    <tbody>
                      @for (r of sec.rows; track $index) {
                        <tr [class]="'t-' + (r.tone ?? 'none')" [class.go]="!!r.nodeId" (click)="r.nodeId && revealHop(r.nodeId)" [title]="r.nodeId ? 'Show on the map' : ''">
                          @for (c of r.cells; track $index) { <td>{{ c }}</td> }
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else { <div class="small text-muted mb-50">{{ sec.empty ?? 'None.' }}</div> }
              }
              @if (p.related.length) {
                <div class="nm-kv-h">Associated resources</div>
                @for (g of p.related; track g.title) {
                  <details class="nm-fold" [open]="g.items.length <= 8">
                    <summary>{{ g.title }}</summary>
                    <ul class="nm-rel">
                      @for (it of g.items; track it.nodeId) {
                        <li (click)="openRelated(it.nodeId)" title="Select and show on the map"><span class="l">{{ it.label }}</span><span class="s">{{ it.sub }}</span></li>
                      }
                      @if (g.more) { <li class="more">+{{ g.more }} more — see the Inventory tab</li> }
                    </ul>
                  </details>
                }
              }
              @if (p.list.length) { <ul class="small pl-1">@for (l of p.list; track l) { <li>{{ l }}</li> }</ul> }
              @if (p.rows.length) {
                <details class="nm-fold"><summary>Details</summary><div class="nm-kv">@for (r of p.rows; track r[0]) { <span class="k">{{ r[0] }}</span><span class="v">{{ r[1] }}</span> }</div></details>
              }
              @if (p.tags.length) {
                <details class="nm-fold"><summary>Tags ({{ p.tags.length }})</summary><div class="nm-kv">@for (r of p.tags; track r[0]) { <span class="k">{{ r[0] }}</span><span class="v">{{ r[1] }}</span> }</div></details>
              }
              @if (p.attrs.length) {
                <details class="nm-fold"><summary>Attributes ({{ p.attrs.length }})</summary><div class="nm-kv">@for (r of p.attrs; track r[0]) { <span class="k">{{ r[0] }}</span><span class="v">{{ r[1] }}</span> }</div></details>
              }
              @if (p.nodeId) {
                <details class="nm-fold" [open]="rawOpen()" (toggle)="rawOpen.set($any($event.target).open)"><summary>Raw (sanitized)</summary>
                  @if (rawOpen()) { <pre>{{ rawText() }}</pre> }
                </details>
              }
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
  /** The snapshot whose graph is on screen. */
  private readonly shownSnapshot = signal<string | null>(null);

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
  /** The snapshot as shown: Kubernetes system namespaces removed (older snapshots still contain them). */
  protected readonly viewGraph = computed(() => (this.graph() ? withoutSystemNamespaces(this.graph()!) : null));
  protected readonly idx = computed(() => (this.viewGraph() ? new GraphIndex(this.viewGraph()!) : null));

  // --- path tracing -------------------------------------------------------------------------------------------
  protected readonly traceSource = signal<string | null>(null);
  private readonly traceReq = signal<TraceRequest | null>(null);
  protected readonly traceActive = signal(0);
  /** Re-runs on a new snapshot: the query is kept, the graph changes. */
  private readonly traceResults = computed<PathResult[]>(() => {
    const idx = this.idx();
    const q = this.traceReq();
    if (!idx || !q) return [];
    return q.direction === 'inbound' ? traceInbound(idx, q) : [tracePath(idx, q)];
  });
  protected readonly inboundWhy = computed(() => {
    const idx = this.idx();
    const q = this.traceReq();
    if (!idx || !q || q.direction !== 'inbound' || this.traceResults().length) return [];
    return inboundHints(idx, q.from, q.protocol, q.port);
  });
  protected readonly activePath = computed(() => {
    const rs = this.traceResults();
    return rs.length ? rs[Math.min(this.traceActive(), rs.length - 1)] : null;
  });
  protected readonly traceView = computed(() => {
    const q = this.traceReq();
    const idx = this.idx();
    if (!q || !idx) return null;
    const from = idx.node(q.from);
    const name = from ? from.name || from.nativeId : q.from;
    const traffic = q.protocol === 'tcp' || q.protocol === 'udp' ? `${q.protocol}/${q.port}` : q.protocol === 'all' ? 'all traffic' : 'icmp';
    const to = !q.to || q.to.kind === 'internet' ? 'the internet' : q.to.kind === 'ip' ? q.to.ip : idx.node(q.to.id)?.name ?? q.to.id;
    const path = this.activePath();
    const rs = this.traceResults();
    return {
      title: q.direction === 'inbound' ? `Inbound to ${name}` : `Path from ${name}`,
      sub: q.direction === 'inbound' ? `${traffic} from every entry point found` : `${traffic} → ${to}`,
      entries: rs.map(r => ({ label: r.label ?? r.summary, icon: OUTCOME_ICON[r.outcome] })),
      active: path ? rs.indexOf(path) : 0,
      path,
      outcomeText: path ? OUTCOME_TEXT[path.outcome] + (path.uncertain ? ' (not every check could be verified)' : '') : '',
    };
  });

  protected readonly scopes = signal<WorkspaceScope[]>([]);
  protected readonly outsideScope = signal('');
  protected readonly adding = signal(false);
  protected readonly outsideInfo = computed(() => {
    const p = this.activePath();
    const idx = this.idx();
    const spec = this.item()?.spec;
    if (!p || p.outcome !== 'leaves-blueprint' || !p.outside || !idx || !spec) return null;
    const n = idx.node(p.outside.nodeId);
    const name = (n?.attrs?.['nameHint'] as string) || n?.name || n?.nativeId || p.outside.nodeId.split(':').slice(4).join(':');
    const addable = n?.kind === 'network' && !!p.outside.networkNativeId;
    const auto = addable ? scopeForAccount(idx, spec.members ?? [], p.outside.account) : undefined;
    const member = addable && (spec.members ?? []).some(m => memberKey(m) === memberKey({ provider: n!.provider || 'aws', region: n!.region ?? p.outside!.region ?? '', networkId: n!.nativeId }));
    return { name, addable, auto, member, account: p.outside.account, region: p.outside.region ?? n?.region ?? '' };
  });

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
  protected readonly workloads = computed(() => (this.idx() ? workloadsData(this.idx()!) : { clusters: [], namespaces: [], services: [], ecsServices: [], lambdas: [] }));

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
      const pods = sel.id.startsWith('agg:pods:');
      // pods folded per owner: list them navigable; double-click the box (or pick one) to expand the namespace
      const related = pods ? [{ title: `Pods (${sel.memberIds.length})`, more: 0, items: sel.memberIds.map(id => idx.node(id)).filter(n => !!n)
        .map(n => ({ nodeId: n!.id, label: n!.name, sub: [String(n!.attrs?.['podIp'] ?? ''), String(n!.attrs?.['phase'] ?? '')].filter(Boolean).join(' · ') })) }] : [];
      return { title: sel.label, sub: pods ? 'Pods of one owner — double-click the box to expand the namespace' : 'Site-to-site VPN connections', nodeId: '', rows: [] as [string, string][], tags: [] as [string, string][], attrs: [] as [string, string][],
        list: pods ? [] : sel.memberIds.map(id => idx.node(id)?.name ?? id), raw: '', sections: [] as ReturnType<typeof nodeDetails>, related: related as ReturnType<typeof relatedResources>, line: '' };
    }
    if (sel.kind === 'edge') {
      const name = (id: string) => idx.node(id)?.name ?? id.replace(/^agg:vpn-sites:/, 'VPN sites → ').replace(/^agg:pods:.*\|[^/]*\//, 'pods of ');
      const underlying = sel.edgeIds.slice(0, 25).map(eid => idx.graph.edges.find(e => e.id === eid)).filter(Boolean);
      return {
        title: `${name(sel.from)} → ${name(sel.to)}`,
        sub: `${sel.count} relationship${sel.count === 1 ? '' : 's'} · ${sel.kinds.join(', ')}`,
        nodeId: '',
        rows: [] as [string, string][],
        tags: [] as [string, string][],
        attrs: [] as [string, string][],
        list: underlying.map(e => `${e!.kind}: ${idx.node(e!.from)?.name ?? e!.from} → ${idx.node(e!.to)?.name ?? e!.to}${e!.attrs && Object.keys(e!.attrs).length ? ` (${Object.entries(e!.attrs).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')})` : ''}`),
        raw: '',
        sections: [] as ReturnType<typeof nodeDetails>,
        related: [] as ReturnType<typeof relatedResources>,
        line: '',
      };
    }
    const n = idx.node(sel.id);
    if (!n) return null;
    const rows: [string, string][] = [
      ['Kind', kindInfo(n.kind).label], ['Id', n.nativeId], ['Account', n.ownerAccount ?? n.account ?? '—'], ['Region', n.region ?? '—'],
      ['Visibility', n.visibility], ['Membership', n.membership], ['State', n.state ?? '—'], ['Seen from', (n.seenFrom ?? []).join(', ') || '—'],
    ];
    const tags = Object.entries(n.tags ?? {}).map(([k, v]) => [k, v] as [string, string]);
    const attrs = Object.entries(n.attrs ?? {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]);
    return { title: n.name, sub: n.id, nodeId: n.id, rows, tags, attrs, list: [] as string[], raw: n.raw ? JSON.stringify(n.raw, null, 2) : '', sections: nodeDetails(idx, n), related: relatedResources(idx, n),
      line: [kindInfo(n.kind).label, n.state, n.region, n.visibility !== 'full' ? n.visibility : ''].filter(Boolean).join(' · ') };
  });

  // --- lazy raw for the side panel ------------------------------------------------------------------------------
  // The graph arrives with raw only for network ACLs and security groups (what the path engine reads); any other
  // node's raw is fetched from the snapshot actually displayed when "Raw (sanitized)" is opened.
  protected readonly rawOpen = signal(false);
  private readonly rawCache = new Map<string, string>();
  private readonly rawView = signal<{ key: string; loading: boolean; text: string } | null>(null);
  protected readonly rawText = computed(() => {
    const p = this.panel();
    if (!p?.nodeId) return '';
    if (p.raw) return p.raw;
    const r = this.rawView();
    return r && r.key === rawKey(this.shownSnapshot(), p.nodeId) && !r.loading ? r.text : 'Loading…';
  });
  private readonly rawLoader = effect(() => {
    const p = this.panel();
    const snap = this.shownSnapshot();
    if (!this.rawOpen() || !p?.nodeId || p.raw || !snap) return;
    untracked(() => this.loadRaw(snap, p.nodeId));
  });

  private loadRaw(snapshotId: string, nodeId: string): void {
    const key = rawKey(snapshotId, nodeId);
    const cached = this.rawCache.get(key);
    if (cached !== undefined) { this.rawView.set({ key, loading: false, text: cached }); return; }
    if (this.rawView()?.key === key) return;   // already loading (or failed: re-open the node to retry)
    this.rawView.set({ key, loading: true, text: '' });
    this.svc.nodeRaw(this.id, snapshotId, nodeId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: raw => {
        const text = raw ? JSON.stringify(raw, null, 2) : 'No raw data was collected for this resource.';
        this.rawCache.set(key, text);
        if (this.rawView()?.key === key) this.rawView.set({ key, loading: false, text });
      },
      error: err => {
        if (this.rawView()?.key === key) this.rawView.set({ key, loading: false, text: `Could not load: ${NetworkBlueprintService.errorMessage(err)}` });
      },
    });
  }

  ngOnInit(): void {
    this.load();
    this.svc.scopes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: s => this.scopes.set(s ?? []), error: () => this.scopes.set([]) });
  }

  /** A search hit: drop any previous trace and open the resource on the map with its details. */
  protected onPicked(id: string): void {
    this.clearTrace();
    this.selectNode({ id });
  }

  protected runTrace(req: TraceRequest): void {
    this.traceSource.set(req.from);
    this.traceActive.set(0);
    this.traceReq.set(req);
    this.tab.set('map');
  }

  /** The node panel's "Trace path": outbound to the internet on tcp/443; the bar then offers the other options. */
  protected traceFrom(id: string): void {
    this.runTrace({ from: id, direction: 'outbound', to: { kind: 'internet' }, protocol: 'tcp', port: 443 });
  }

  private readonly traceBar = viewChild(TraceBarComponent);
  private readonly map = viewChild(NetworkMapComponent);

  /** One click back to the starting view: no search, trace, selection or focus; whole blueprint at L1, fitted. */
  protected clearAll(): void {
    this.clearTrace();
    this.traceSource.set(null);
    this.selection.set(null);
    this.reveal.set(null);
    this.traceBar()?.reset();
    this.map()?.resetView();
  }

  protected clearTrace(): void {
    this.traceReq.set(null);
    this.outsideScope.set('');
  }

  /** Navigate the panel: select the related resource and bring it into view on the map. */
  protected openRelated(id: string): void {
    if (!this.idx()?.node(id)) return;
    this.selection.set({ kind: 'node', id });
    this.revealHop(id);
  }

  protected revealHop(id: string): void {
    if (!this.idx()?.node(id)) return;
    this.reveal.set({ id, seq: (this.reveal()?.seq ?? 0) + 1 });
  }

  protected icon(v: Verdict): string {
    return VERDICT_ICON[v];
  }

  /** Add the outside network the path ran into and rescan (PATCH sends the full spec). */
  protected addOutside(): void {
    const it = this.item();
    const idx = this.idx();
    const p = this.activePath();
    const info = this.outsideInfo();
    if (!it || !idx || !p?.outside || !info?.addable) return;
    const member = outsideMember(idx, p.outside, info.auto ?? this.outsideScope());
    if (!member) return;
    this.adding.set(true);
    this.svc.update(it.id, specWithMember(it.spec, member)).subscribe({
      next: () => {
        this.adding.set(false);
        this.awaiting.set(true);
        this.ensurePolling(true);
        this.load();
      },
      error: err => {
        this.adding.set(false);
        alert(NetworkBlueprintService.errorMessage(err));
      },
    });
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
    // Request the snapshot by id (not "latest") so the lazy raw lookups hit the snapshot on screen.
    this.svc.graph(this.id, snapshotId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: g => {
        if (snapshotId !== this.loadedSnapshotId) return;   // a newer snapshot load superseded this one
        this.graph.set(g);
        this.shownSnapshot.set(snapshotId);
      },
      error: err => { if (snapshotId === this.loadedSnapshotId) this.graphError.set(NetworkBlueprintService.errorMessage(err)); },
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

const VERDICT_ICON: Record<Verdict, string> = { allow: '✓', block: '✕', unknown: '?', info: '•' };
const OUTCOME_ICON: Record<PathResult['outcome'], string> = { reaches: '✓', blocked: '✕', unknown: '?', 'leaves-blueprint': '↗' };
const OUTCOME_TEXT: Record<PathResult['outcome'], string> = {
  reaches: 'Reachable', blocked: 'Blocked', unknown: 'Could not be determined', 'leaves-blueprint': 'Leaves this blueprint',
};

const COLLECTOR_LABEL: Record<string, string> = {
  'aws.core-network': 'VPCs, subnets & routes', 'aws.interfaces': 'Interfaces & workloads', 'aws.load-balancers': 'Load balancers',
  'aws.endpoints': 'VPC endpoints', 'aws.transit': 'Transit gateways', 'aws.vpn': 'Site-to-site VPN', 'aws.peering': 'Peering',
  'aws.dns-resolver': 'DNS resolver', 'aws.flow-logs': 'Flow logs', 'aws.eks': 'EKS / Kubernetes', 'aws.ecs': 'ECS', 'aws.lambda': 'Lambda',
  'aws.dns-zones': 'Route 53 zones',
};
const COLLECTOR_ORDER: Record<string, number> = Object.fromEntries(Object.keys(COLLECTOR_LABEL).map((k, i) => [k, i]));

/** Work unit ids are `collector|scopeId|region`. */
function describeUnit(id: string): string {
  const [collector, , region] = id.split('|');
  const label = COLLECTOR_LABEL[collector] ?? collector;
  return region && region !== 'global' ? `${label.toLowerCase()} in ${region}` : label.toLowerCase();
}

function rawKey(snapshotId: string | null, nodeId: string): string {
  return `${snapshotId ?? ''}|${nodeId}`;
}
