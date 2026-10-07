import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { RdsUpgradeService, RdsUpgrade } from '../rds-upgrade.service';

// Custom "Run Detail" visual design (2026-10-07 redesign brief). This intentionally does NOT use the
// platform's view-with-sidecards/sidecard/app-flat-status-filter components -- the brief specifies a
// bespoke layout, color system, and segmented control that don't map onto those generic components, so
// this is a from-scratch template+styles. Two things from the brief are adapted rather than built exactly
// as specified, both called out inline below: (1) IBM Plex Sans/Mono are referenced via font-family with
// system-font fallbacks rather than loaded from a webfont CDN -- this extension's frontend has no
// established pattern for pulling in a new font source, and guessing at the platform's CSP felt riskier
// than a graceful fallback; (2) the sidebar's "Resources" card (CloudWatch logs / Terraform plan links)
// is omitted -- rdsupgrade's Result has no such data, and fabricating non-functional links felt worse
// than leaving them out.
@Component({
  selector: 'rds-view',
  imports: [DatePipe],
  styles: [`
    :host {
      display: block;
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --ink: #171023;
      --violet: #6D4AFF;
      --violet-hover: #5B3DF0;
      --violet-tint: #F5F2FF;
      --violet-tint-strong: #EAE4FF;
      --green: #10B981;
      --green-text: #059669;
      --green-tint: #ECFDF5;
      --amber: #F59E0B;
      --amber-text: #B45309;
      --amber-tint: #FFFBEB;
      --gray-100: #F1F5F9;
      --gray-300: #CBD5E1;
      --gray-400: #94A3B8;
      --slate-900: #0F172A;
      --slate-700: #334155;
      --slate-500: #64748B;
      --slate-400: #94A3B8;
      --border: #E2E8F0;
      --bg: #F8FAFC;
      background: var(--bg);
    }
    .mono { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }

    /* ── Page header ── */
    .page-header { padding: 20px 24px 8px; }
    .breadcrumb { font-size: 12px; color: var(--slate-500); margin: 0 0 4px; }
    .header-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .page-title { font-size: 22px; font-weight: 700; color: var(--ink); margin: 0; }
    .header-spacer { flex: 1 1 auto; }
    .btn-ghost {
      background: transparent; border: 1px solid var(--border); border-radius: 8px; padding: 7px 14px;
      font-size: 13px; font-weight: 600; color: var(--slate-700); cursor: pointer;
    }
    .btn-ghost:hover { border-color: var(--violet); color: var(--violet); }
    .btn-icon {
      width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--border); background: #fff;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--slate-500);
    }
    .btn-icon:hover { border-color: var(--violet); color: var(--violet); }

    /* ── Two-column body ── */
    .body { display: flex; gap: 20px; padding: 16px 24px 32px; align-items: flex-start; flex-wrap: wrap; }
    .main-col { flex: 1 1 560px; min-width: 320px; }
    .side-col { flex: 0 1 280px; min-width: 240px; }

    /* ── Main card ── */
    .card {
      background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 24px;
      box-shadow: 0 1px 2px rgba(15,23,42,.04);
    }
    .card + .card { margin-top: 16px; }
    .card-header-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 11px; font-size: 12px; font-weight: 700; }
    .pill-green { background: var(--green-tint); color: var(--green-text); }
    .pill-amber { background: var(--amber-tint); color: var(--amber-text); }
    .pill-red { background: #FEF2F2; color: #DC2626; }
    .pill-gray { background: var(--gray-100); color: var(--slate-500); }
    .elapsed { font-size: 13px; color: var(--slate-500); }
    .tabs { margin-left: auto; display: inline-flex; background: var(--gray-100); border-radius: 9px; padding: 3px; }
    .tab-btn {
      border: none; background: transparent; border-radius: 7px; padding: 6px 16px; font-size: 13px;
      font-weight: 600; color: var(--slate-500); cursor: pointer;
    }
    .tab-btn.active { background: var(--violet); color: #fff; }

    /* ── Stepper ── */
    .stepper { display: flex; align-items: flex-start; overflow-x: auto; padding: 8px 4px 4px; margin-bottom: 28px; }
    .step-node { display: flex; flex-direction: column; align-items: center; min-width: 88px; position: relative; }
    .step-node .connector {
      position: absolute; top: 19px; left: calc(-50% + 19px); width: calc(100% - 38px); height: 2px;
      background: var(--gray-300); z-index: 0;
    }
    .step-node:first-child .connector { display: none; }
    .step-node.connector-done .connector { background: var(--green); }
    .circle {
      width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      border: 2px solid var(--gray-300); background: var(--gray-100); color: var(--gray-400); z-index: 1; flex-shrink: 0;
      position: relative;
    }
    .circle svg { width: 17px; height: 17px; }
    .step-node.current .circle { background: var(--amber-tint); border-color: var(--amber); color: var(--amber); }
    .step-node.done .circle { background: var(--green-tint); border-color: var(--green); color: var(--green-text); }
    .step-node.finalnode .circle { background: var(--gray-100); border-color: var(--gray-300); color: var(--gray-400); }
    .step-node.finalnode.done .circle { background: var(--violet); border-color: var(--violet); color: #fff; }
    .step-badge {
      position: absolute; bottom: -2px; right: -2px; width: 16px; height: 16px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; border: 2px solid #fff; z-index: 2;
    }
    .step-badge svg { width: 9px; height: 9px; stroke-width: 3.5; }
    .step-node.done .step-badge { background: var(--green); color: #fff; }
    .step-node.current .step-badge { background: var(--amber); color: #fff; }
    .step-node.current .step-badge svg { animation: spin 1s linear infinite; }
    .step-label { margin-top: 8px; font-size: 11px; font-weight: 600; color: var(--slate-500); text-align: center; }
    .step-node.done .step-label, .step-node.finalnode.done .step-label { color: var(--green-text); }
    .step-node.finalnode.done .step-label { color: var(--violet); }
    .step-node.current .step-label { color: var(--amber-text); }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Deployment details ── */
    .section-title { font-size: 13px; font-weight: 700; color: var(--slate-900); margin: 0 0 10px; text-transform: uppercase; letter-spacing: .02em; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
    @media (max-width: 560px) { .stat-grid { grid-template-columns: 1fr; } }
    .stat-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .stat-card.full { grid-column: 1 / -1; }
    .stat-card.highlight { background: var(--violet-tint); border-color: var(--violet-tint-strong); }
    .stat-label { font-size: 11px; color: var(--slate-500); font-weight: 600; margin: 0 0 4px; }
    .stat-value-row { display: flex; align-items: center; gap: 6px; }
    .stat-value { font-size: 13px; color: var(--slate-900); word-break: break-all; }
    .stat-value.struck { text-decoration: line-through; color: var(--slate-400); }
    .port-badge { background: var(--gray-100); color: var(--slate-700); font-size: 10px; font-weight: 700; border-radius: 5px; padding: 1px 6px; flex-shrink: 0; }
    .copy-btn { border: none; background: transparent; cursor: pointer; color: var(--slate-400); display: inline-flex; padding: 2px; flex-shrink: 0; }
    .copy-btn:hover { color: var(--violet); }
    .copy-btn svg { width: 13px; height: 13px; }
    .copied-tag { font-size: 10px; color: var(--green-text); font-weight: 700; }

    /* ── Current status card ── */
    .status-card { border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; }
    .status-top-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .status-detail { font-size: 12px; color: var(--slate-500); margin: 0 0 10px; font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
    .status-main { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--slate-900); }
    .status-main svg { width: 16px; height: 16px; color: var(--green-text); }
    .status-main.is-failed svg { color: #DC2626; }
    .progress-track { height: 6px; background: var(--gray-100); border-radius: 999px; overflow: hidden; margin-bottom: 10px; }
    .progress-fill { height: 100%; background: var(--green); border-radius: 999px; transition: width .3s; }
    .progress-fill.is-failed { background: #DC2626; }
    .legend-row { display: flex; gap: 16px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--slate-500); }
    .legend-swatch { width: 9px; height: 9px; border-radius: 50%; }
    .legend-swatch.gray { background: var(--gray-300); }
    .legend-swatch.amber { background: var(--amber); }
    .legend-swatch.green { background: var(--green); }

    /* ── Step history ── */
    .history-scroll { max-height: 340px; overflow-y: auto; padding-right: 6px; }
    .history-row { display: flex; gap: 12px; position: relative; padding-bottom: 20px; }
    .history-row:last-child { padding-bottom: 0; }
    .history-rail { display: flex; flex-direction: column; align-items: center; width: 24px; flex-shrink: 0; }
    .history-dot {
      width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; z-index: 1;
    }
    .history-dot svg { width: 11px; height: 11px; color: #fff; }
    .history-dot.ok { background: var(--green); }
    .history-dot.warn { background: var(--amber); }
    .history-dot.fail { background: #EF4444; }
    .history-line { width: 2px; flex: 1 1 auto; background: var(--border); margin-top: 2px; }
    .history-row:last-child .history-line { display: none; }
    .history-body { flex: 1 1 auto; padding-top: 1px; }
    .history-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .history-title { font-size: 13px; font-weight: 700; color: var(--slate-900); }
    .history-time { font-size: 11px; color: var(--slate-400); margin-top: 2px; }
    .history-detail { font-size: 12px; color: var(--slate-500); margin-top: 4px; word-break: break-all; }

    /* ── Footer ── */
    .card-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); flex-wrap: wrap; gap: 10px; }
    .footer-text { font-size: 13px; color: var(--slate-500); }
    .btn-primary {
      background: var(--violet); color: #fff; border: none; border-radius: 8px; padding: 9px 18px;
      font-size: 13px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    }
    .btn-primary:hover { background: var(--violet-hover); }
    .btn-primary:disabled { opacity: .6; cursor: default; }

    /* ── Sidebar ── */
    .overview-row { display: flex; align-items: center; gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--border); }
    .overview-row:last-child { border-bottom: none; padding-bottom: 2px; }
    .overview-row svg { width: 15px; height: 15px; color: var(--slate-400); flex-shrink: 0; }
    .overview-label { font-size: 11px; color: var(--slate-500); margin: 0; }
    .overview-value { font-size: 13px; font-weight: 600; color: var(--slate-900); margin: 1px 0 0; }

    .spec-row { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .spec-row:last-child { border-bottom: none; }
    .spec-key { color: var(--slate-500); }
    .spec-val { color: var(--slate-900); font-weight: 600; text-align: right; }
  `],
  template: `
    @if (item(); as it) {
      <div class="page-header">
        <div class="header-row">
          <div class="header-spacer"></div>
          <button class="btn-ghost" (click)="activePanel.set('spec')">View spec</button>
          <button class="btn-icon" title="Download result as JSON" (click)="downloadJson(it)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </button>
        </div>
      </div>

      <div class="body">
        <div class="main-col">
          <div class="card">
            <div class="card-header-row">
              <span class="pill" [class]="statusPillClass(it.status)">{{ it.status }}</span>
              <span class="elapsed">{{ elapsedLabel() }}</span>
              <div class="tabs">
                <button class="tab-btn" [class.active]="activePanel()==='result'" (click)="activePanel.set('result')">Result</button>
                <button class="tab-btn" [class.active]="activePanel()==='spec'" (click)="activePanel.set('spec')">Spec</button>
              </div>
            </div>

            @if (activePanel() === 'result') {
              <div class="stepper">
                @for (node of phaseNodes(); track node.phase) {
                  <div class="step-node"
                       [class.current]="node.state==='current'" [class.done]="node.state==='done'"
                       [class.finalnode]="node.phase==='Completed'"
                       [class.connector-done]="node.connectorDone">
                    <div class="connector"></div>
                    <div class="circle">
                      @switch (node.icon) {
                        @case ('search') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> }
                        @case ('camera') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> }
                        @case ('sliders') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg> }
                        @case ('git-branch') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg> }
                        @case ('shield') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg> }
                        @case ('repeat') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg> }
                        @case ('eye') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg> }
                        @case ('trash') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> }
                        @case ('flag') { <svg viewBox="0 0 24 24" [attr.fill]="node.state==='done' ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg> }
                      }
                      @if (node.state === 'done') {
                        <span class="step-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
                      } @else if (node.state === 'current') {
                        <span class="step-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span>
                      }
                    </div>
                    <div class="step-label">{{ node.label }}</div>
                  </div>
                }
              </div>

              <p class="section-title">Deployment details</p>
              <div class="stat-grid">
                <div class="stat-card">
                  <p class="stat-label">Snapshot</p>
                  <div class="stat-value-row">
                    <span class="stat-value mono">{{ it.result?.snapshotIdentifier || '—' }}</span>
                    @if (it.result?.snapshotIdentifier) { <button class="copy-btn" (click)="copy('snapshotIdentifier', it.result!.snapshotIdentifier!)">{{ copyIcon('snapshotIdentifier') }}</button> }
                  </div>
                </div>
                <div class="stat-card">
                  <p class="stat-label">Blue/Green deployment</p>
                  <div class="stat-value-row">
                    <span class="stat-value mono">{{ it.result?.blueGreenDeploymentId || '—' }}</span>
                    @if (it.result?.blueGreenDeploymentId) { <button class="copy-btn" (click)="copy('bg', it.result!.blueGreenDeploymentId!)">{{ copyIcon('bg') }}</button> }
                  </div>
                </div>
                <div class="stat-card">
                  <p class="stat-label">Green endpoint</p>
                  <div class="stat-value-row">
                    <span class="stat-value mono">{{ hostOnly(it.result?.greenEndpoint) || '—' }}</span>
                    @if (portOf(it.result?.greenEndpoint); as port) { <span class="port-badge">{{ port }}</span> }
                    @if (it.result?.greenEndpoint) { <button class="copy-btn" (click)="copy('green', it.result!.greenEndpoint!)">{{ copyIcon('green') }}</button> }
                  </div>
                </div>
                <div class="stat-card highlight">
                  <p class="stat-label">Final endpoint</p>
                  <div class="stat-value-row">
                    <span class="stat-value mono">{{ hostOnly(it.result?.finalEndpoint) || '—' }}</span>
                    @if (portOf(it.result?.finalEndpoint); as port) { <span class="port-badge">{{ port }}</span> }
                    @if (it.result?.finalEndpoint) { <button class="copy-btn" (click)="copy('final', it.result!.finalEndpoint!)">{{ copyIcon('final') }}</button> }
                  </div>
                </div>
                <div class="stat-card full">
                  <p class="stat-label">Old instance — removed at cleanup</p>
                  <span class="stat-value mono struck">{{ it.result?.oldInstanceIdentifier || '—' }}</span>
                </div>
              </div>

              <div class="status-card">
                <div class="status-top-row">
                  <div class="status-main" [class.is-failed]="it.status==='Failed'">
                    @if (it.status === 'Failed') {
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                    } @else {
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    }
                    {{ statusHeadline() }}
                  </div>
                  <span class="elapsed">{{ elapsedLabel() }}</span>
                </div>
                @if (it.status === 'Processing' && it.subStatus) {
                  <p class="status-detail">{{ it.subStatus }}</p>
                }
                <div class="progress-track"><div class="progress-fill" [class.is-failed]="it.status==='Failed'" [style.width.%]="progressPercent()"></div></div>
                <div class="legend-row">
                  <span class="legend-item"><span class="legend-swatch gray"></span>Not started</span>
                  <span class="legend-item"><span class="legend-swatch amber"></span>In progress</span>
                  <span class="legend-item"><span class="legend-swatch green"></span>Complete</span>
                </div>
              </div>

              <p class="section-title">Step history</p>
              <div class="history-scroll">
                @if (!it.result?.stepHistory?.length) {
                  <p class="footer-text">No steps recorded yet.</p>
                }
                @for (step of it.result?.stepHistory; track $index) {
                  <div class="history-row">
                    <div class="history-rail">
                      <div class="history-dot" [class]="historyDotClass(step.status)">
                        @if (step.status === 'Failed') {
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        } @else {
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        }
                      </div>
                      <div class="history-line"></div>
                    </div>
                    <div class="history-body">
                      <div class="history-title-row">
                        <span class="history-title">{{ step.phase }}</span>
                        <span class="pill" [class]="historyPillClass(step.status)">{{ step.status }}</span>
                        @if (isResumed(step.message)) { <span class="pill pill-amber">Resumed</span> }
                      </div>
                      <div class="history-time mono">
                        {{ step.startedAt | date:'MMM d, h:mm:ss a' }}
                        @if (step.completedAt) { &nbsp;→&nbsp;{{ step.completedAt | date:'MMM d, h:mm:ss a' }} }
                      </div>
                      @if (step.message) { <div class="history-detail">{{ step.message }}</div> }
                    </div>
                  </div>
                }
              </div>

              <div class="card-footer">
                <span class="footer-text">{{ it.status === 'Processing' ? 'In progress…' : (it.subStatus || 'Awaiting first update.') }}</span>
                <button class="btn-primary" (click)="track()" [disabled]="tracking()">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M13 2 3 14h7l-1 8 10-12h-7z"></path></svg>
                  Track provisioning status
                </button>
              </div>
            } @else {
              <p class="section-title">Spec</p>
              <div class="spec-row"><span class="spec-key">Instance</span><span class="spec-val mono">{{ it.spec?.dbInstanceIdentifier || '—' }}</span></div>
              <div class="spec-row"><span class="spec-key">Region</span><span class="spec-val">{{ it.spec?.region || '—' }}</span></div>
              <div class="spec-row"><span class="spec-key">Target engine version</span><span class="spec-val mono">{{ it.spec?.targetEngineVersion || '—' }}</span></div>
              <div class="spec-row"><span class="spec-key">Target instance class</span><span class="spec-val">{{ it.spec?.targetInstanceClass || 'source default' }}</span></div>
              <div class="spec-row"><span class="spec-key">Target parameter group</span><span class="spec-val">{{ it.spec?.targetParameterGroupName || 'cloned from source' }}</span></div>
              <div class="spec-row"><span class="spec-key">Switchover timeout</span><span class="spec-val">{{ it.spec?.switchoverTimeoutMinutes || 5 }} min</span></div>
            }
          </div>
        </div>

        <div class="side-col">
          <div class="card">
            <p class="section-title">Run overview</p>
            <div class="overview-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
              <div><p class="overview-label">Status</p><p class="overview-value">{{ it.status }}</p></div>
            </div>
            <div class="overview-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M6 9v6"></path><path d="M20 4 9 15"></path><path d="M14 4h6v6"></path></svg>
              <div><p class="overview-label">Phase</p><p class="overview-value">{{ it.result?.phase || '—' }}</p></div>
            </div>
            <div class="overview-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
              <div><p class="overview-label">Created at</p><p class="overview-value">{{ it.createdAt | date:'medium' }}</p></div>
            </div>
          </div>
        </div>
      </div>
    } @else {
      <div class="footer-text" style="padding: 24px;">Loading…</div>
    }
  `,
})
export class ViewRdsUpgradeComponent implements OnInit {
  private readonly svc = inject(RdsUpgradeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly item = signal<RdsUpgrade | undefined>(undefined);
  protected readonly activePanel = signal<'spec' | 'result'>('spec');
  protected readonly tracking = signal(false);
  protected readonly copiedField = signal<string | null>(null);

  private static readonly PHASE_SEQUENCE: { phase: string; label: string; icon: string }[] = [
    { phase: 'Prechecking', label: 'Precheck', icon: 'search' },
    { phase: 'Snapshotting', label: 'Snapshot', icon: 'camera' },
    { phase: 'CreatingParamGroup', label: 'Param Group', icon: 'sliders' },
    { phase: 'CreatingBlueGreen', label: 'Blue/Green', icon: 'git-branch' },
    { phase: 'ValidatingGreen', label: 'Validate', icon: 'shield' },
    { phase: 'CuttingOver', label: 'Switchover', icon: 'repeat' },
    { phase: 'PostVerify', label: 'Verify', icon: 'eye' },
    { phase: 'CleaningUp', label: 'Cleanup', icon: 'trash' },
    { phase: 'Completed', label: 'Completed', icon: 'flag' },
  ];

  protected readonly phaseNodes = computed(() => {
    const result = this.item()?.result;
    const doneSet = new Set((result?.stepHistory ?? []).filter(s => s.status === 'OK').map(s => s.phase));
    const overallFailed = result?.phase === 'Failed';
    const overallCompleted = result?.phase === 'Completed';
    const firstPendingIndex = ViewRdsUpgradeComponent.PHASE_SEQUENCE.findIndex(n => !doneSet.has(n.phase));

    let lastDoneIndex = -1;
    return ViewRdsUpgradeComponent.PHASE_SEQUENCE.map((node, i) => {
      let state: 'done' | 'current' | 'failed' | 'pending';
      if (doneSet.has(node.phase) || (node.phase === 'Completed' && overallCompleted)) {
        state = 'done';
        lastDoneIndex = i;
      } else if (i === firstPendingIndex) {
        state = overallFailed ? 'failed' : 'current';
      } else {
        state = 'pending';
      }
      return { ...node, state, connectorDone: i <= lastDoneIndex + (state === 'done' ? 0 : 0) };
    }).map((node, i, arr) => ({ ...node, connectorDone: i > 0 && arr[i - 1].state === 'done' }));
  });

  protected readonly progressPercent = computed(() => {
    const nodes = this.phaseNodes().filter(n => n.phase !== 'Completed');
    const done = nodes.filter(n => n.state === 'done').length;
    return Math.round((done / nodes.length) * 100);
  });

  protected readonly stepsCompletedCount = computed(() =>
    this.phaseNodes().filter(n => n.phase !== 'Completed' && n.state === 'done').length);

  ngOnInit(): void {
    const id = this.route.snapshot.params['id'];
    this.svc.get(id).subscribe(i => {
      this.item.set(i);
      this.activePanel.set(i?.result?.stepHistory?.length ? 'result' : 'spec');
    });
  }

  protected statusPillClass(status: string | undefined): string {
    switch (status) {
      case 'Complete': return 'pill-green';
      case 'Failed': return 'pill-red';
      case 'Processing': return 'pill-amber';
      default: return 'pill-gray';
    }
  }

  protected historyDotClass(status: string): string {
    if (status === 'Failed') return 'fail';
    if (status === 'Warning') return 'warn';
    return 'ok';
  }

  protected historyPillClass(status: string): string {
    if (status === 'Failed') return 'pill-red';
    if (status === 'Warning') return 'pill-amber';
    return 'pill-green';
  }

  protected isResumed(message?: string): boolean {
    return !!message && /resumed|already completed on a prior attempt/i.test(message);
  }

  protected statusHeadline(): string {
    const it = this.item();
    if (it?.status === 'Failed') return 'Run failed';
    if (it?.result?.phase === 'Completed') return 'All steps completed';
    return `${this.stepsCompletedCount()} of 8 steps finished`;
  }

  protected elapsedLabel(): string {
    const it = this.item();
    if (!it?.createdAt) return '';
    const start = new Date(it.createdAt).getTime();
    const steps = it.result?.stepHistory ?? [];
    const lastCompleted = steps.length ? steps[steps.length - 1].completedAt : undefined;
    const end = (it.result?.phase === 'Completed' || it.status === 'Failed') && lastCompleted
      ? new Date(lastCompleted).getTime()
      : Date.now();
    const mins = Math.max(0, Math.round((end - start) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  protected hostOnly(endpoint?: string | null): string {
    return endpoint ? endpoint.split(':')[0] : '';
  }

  protected portOf(endpoint?: string | null): string {
    const parts = endpoint?.split(':') ?? [];
    return parts.length > 1 ? parts[1] : '';
  }

  protected copyIcon(field: string): string {
    return this.copiedField() === field ? '✓' : '⧉';
  }

  protected copy(field: string, value: string): void {
    navigator.clipboard?.writeText(value).then(() => {
      this.copiedField.set(field);
      setTimeout(() => {
        if (this.copiedField() === field) this.copiedField.set(null);
      }, 1500);
    });
  }

  protected downloadJson(it: RdsUpgrade): void {
    const blob = new Blob([JSON.stringify(it, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${it.name || 'rds-upgrade'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 'view/:id' is two URL segments, so climb both before addressing the sibling 'edit/:id'.
  protected edit(): void {
    const it = this.item();
    if (it) {
      this.router.navigate(['../..', 'edit', it.id], { relativeTo: this.route });
    }
  }

  protected track(): void {
    const it = this.item();
    if (!it) {
      return;
    }
    this.tracking.set(true);
    this.svc.ticketName(it.id).subscribe({
      next: name => {
        this.tracking.set(false);
        if (!name) {
          return;
        }
        this.router.navigate(['/ai/service-desk', this.svc.workspaceId(), 'tickets', 'chat', name]);
      },
      error: () => this.tracking.set(false),
    });
  }

}
