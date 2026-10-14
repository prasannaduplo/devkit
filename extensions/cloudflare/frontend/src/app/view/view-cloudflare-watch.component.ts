import { Component, DestroyRef, LOCALE_ID, OnInit, computed, inject, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { CloudflareWatch, CloudflareWatchService, WorkerEvent } from '../cloudflare-watch.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { LifecyclePhase, LifecycleRailComponent, RailCallout, RailFact } from '../shared/lifecycle-rail.component';

// Detail view (Template-G shell, reference/19-detail-page.md) for a WORKER resource: no ticket, so no Ask agent /
// Track status. Ladder: Created → Queued → Baseline scan → Watching (rescans every 5 min, subtitled from workerState).
@Component({
  selector: 'cfw-view',
  imports: [CommonLibComponentsModule, StatusBadgeComponent, LifecycleRailComponent],
  styleUrl: '../shared/detail-page.scss',
  styles: [`
    .cfw-table { width: 100%; font-size: .9rem; }
    .cfw-table th { font-weight: 600; color: #6e6b7b; padding: .5rem .75rem; border-bottom: 1px solid #ebe9f1; white-space: nowrap; }
    .cfw-table td { padding: .5rem .75rem; border-bottom: 1px solid #f3f2f7; vertical-align: top; }
    .cfw-kind { font-size: .75rem; font-weight: 600; padding: .1rem .45rem; border-radius: .25rem; white-space: nowrap; }
    .cfw-kind.Deployed { background: #e5f0ff; color: #1f5fbf; }
    .cfw-kind.ScriptAdded { background: #e3f6ea; color: #1d7a3e; }
    .cfw-kind.ScriptDeleted { background: #fdeaea; color: #b42318; }
    .cfw-muted { color: #8a8797; }
  `],
  template: `
    @if (item(); as it) {
      <div class="ext-detail-page">

        <header class="g-head">
          <span class="g-tile-ic"><i data-feather="cloud" size="26"></i></span>
          <div class="g-head-main">
            <div class="g-head-t">
              <h1>{{ it.name }}</h1>
              <app-status-badge [status]="it.status"></app-status-badge>
              @if (working()) {
                <span class="dots-loader text-warning"><span></span><span></span><span></span></span>
              }
            </div>
            <div class="g-meta">
              <span class="g-meta-item"><span class="k">Account:</span> <span class="mono">{{ it.result?.accountId ?? '—' }}</span></span>
              <span class="sep">·</span>
              <span class="g-meta-item"><span class="k">Filter:</span> <span class="mono">{{ it.spec?.scriptNameFilter || 'all Workers' }}</span></span>
              <span class="sep">·</span>
              <span class="g-meta-item"><span class="k">Last scan:</span> {{ fmt(it.result?.lastScannedAt) }}</span>
            </div>
          </div>
          <div class="g-actions">
            <div class="seg" role="group" aria-label="View">
              <button type="button" [class.active]="view() === 'spec'" (click)="view.set('spec')">Spec</button>
              <button type="button" [class.active]="view() === 'result'" (click)="view.set('result')">Result</button>
            </div>
            <div ngbDropdown container="body" placement="bottom-right">
              <button type="button" class="btn btn-sm hide-arrow" aria-label="More actions" ngbDropdownToggle>
                <i data-feather="more-vertical"></i>
              </button>
              <div ngbDropdownMenu>
                <a ngbDropdownItem (click)="edit()"><i data-feather="edit" class="mr-50"></i> Edit</a>
              </div>
            </div>
          </div>
        </header>

        <div class="g-cols">
          <section class="g-card g-main">
            @if (view() === 'spec') {
              <div class="g-sec pt-1">
                <div class="g-sec-h"><h3>Requested spec</h3></div>
                <div class="g-tiles c3">
                  <div class="g-tile"><div class="g-tl">Scope</div><span class="g-tv mono">{{ it.spec?.scopeIds?.[0] ?? '—' }}</span></div>
                  <div class="g-tile"><div class="g-tl">Script filter</div><span class="g-tv mono">{{ it.spec?.scriptNameFilter || 'all' }}</span></div>
                  <div class="g-tile"><div class="g-tl">History limit</div><span class="g-tv">{{ it.spec?.historyLimit ?? 200 }}</span></div>
                </div>
              </div>
            } @else {
              <scrollable-nav-tab>
                <ul ngbNav #resultNav="ngbNav" class="nav nav-tabs flat-tabs g-tabs" [(activeId)]="activeTab">
                  <li [ngbNavItem]="'overview'">
                    <a ngbNavLink>Overview</a>
                    <ng-template ngbNavContent>
                      @if (it.faults?.length) {
                        <div class="alert alert-danger py-1 px-2 mb-1">
                          @for (f of it.faults; track f) { <div>{{ f }}</div> }
                        </div>
                      }
                      @if (it.result?.lastError) {
                        <div class="alert alert-warning py-1 px-2 mb-1">Last scan failed: {{ it.result?.lastError }}</div>
                      }
                      <div class="g-sec">
                        <div class="g-sec-h"><h3>Account</h3></div>
                        <div class="g-tiles c3">
                          <div class="g-tile"><div class="g-tl">Workers watched</div><span class="g-tv">{{ it.result?.scriptCount ?? '—' }}
                            @if (it.result?.pendingScripts) { <small>{{ it.result?.pendingScripts }} still being fetched</small> }</span></div>
                          <div class="g-tile"><div class="g-tl">API token</div><span class="g-tv">{{ it.result?.tokenStatus ?? '—' }}
                            @if (it.result?.tokenExpiresOn) { <small>expires {{ fmt(it.result?.tokenExpiresOn) }}</small> }</span></div>
                          <div class="g-tile"><div class="g-tl">Baseline</div><span class="g-tv">{{ fmt(it.result?.baselineAt) }}</span></div>
                        </div>
                      </div>
                      <div class="g-sec">
                        <div class="g-sec-h"><h3>Changes since baseline</h3></div>
                        <div class="g-tiles c3">
                          <div class="g-tile"><div class="g-tl">Deployments</div><span class="g-tv">{{ it.result?.eventCounts?.deployed ?? 0 }}</span></div>
                          <div class="g-tile"><div class="g-tl">Workers added</div><span class="g-tv">{{ it.result?.eventCounts?.added ?? 0 }}</span></div>
                          <div class="g-tile"><div class="g-tl">Workers deleted</div><span class="g-tv">{{ it.result?.eventCounts?.deleted ?? 0 }}</span></div>
                        </div>
                      </div>
                    </ng-template>
                  </li>

                  <li [ngbNavItem]="'workers'">
                    <a ngbNavLink>Workers ({{ it.result?.scripts?.length ?? 0 }})</a>
                    <ng-template ngbNavContent>
                      @if (it.result?.scripts?.length) {
                        <table class="cfw-table">
                          <thead><tr><th>Worker</th><th>Live deployment</th><th>Deployed</th><th>By</th><th>Source</th><th>Message</th></tr></thead>
                          <tbody>
                            @for (s of it.result?.scripts; track s.name) {
                              <tr>
                                <td class="mono">{{ s.name }}</td>
                                <td class="mono">{{ short(s.currentDeploymentId) }}
                                  @if ((s.currentVersionIds?.length ?? 0) > 1) { <span class="cfw-muted">(split {{ s.currentVersionIds?.length }} versions)</span> }</td>
                                <td>{{ fmt(s.lastDeployedAt) }}</td>
                                <td>{{ s.lastDeployedBy ?? '—' }}</td>
                                <td>{{ s.lastDeploySource ?? '—' }}</td>
                                <td>{{ s.lastDeployMessage ?? '' }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      } @else {
                        <div class="text-muted p-1">No Workers seen yet.</div>
                      }
                    </ng-template>
                  </li>

                  <li [ngbNavItem]="'activity'">
                    <a ngbNavLink>Activity ({{ it.result?.events?.length ?? 0 }})</a>
                    <ng-template ngbNavContent>
                      @if (it.result?.events?.length) {
                        <table class="cfw-table">
                          <thead><tr><th>When</th><th>Change</th><th>Worker</th><th>Deployment</th><th>By</th><th>Message</th></tr></thead>
                          <tbody>
                            @for (e of it.result?.events; track $index) {
                              <tr>
                                <td>{{ fmt(e.at) }}</td>
                                <td><span class="cfw-kind" [class]="'cfw-kind ' + e.kind">{{ label(e) }}</span></td>
                                <td class="mono">{{ e.script }}</td>
                                <td class="mono">{{ short(e.deploymentId) }}</td>
                                <td>{{ e.author ?? '—' }}</td>
                                <td>{{ e.message ?? '' }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      } @else {
                        <div class="text-muted p-1">No changes since the baseline. Deployments, new and deleted Workers appear here.</div>
                      }
                    </ng-template>
                  </li>
                </ul>
              </scrollable-nav-tab>
              <div [ngbNavOutlet]="resultNav" class="mt-50"></div>
            }
          </section>

          <ext-lifecycle-rail [phases]="phases()" [attached]="attached()" [callout]="callout()" attachedTitle="Worker" />
        </div>
      </div>
    } @else {
      <div class="text-muted p-2">Loading…</div>
    }
  `,
})
export class ViewCloudflareWatchComponent implements OnInit {
  private readonly svc = inject(CloudflareWatchService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  protected readonly item = signal<CloudflareWatch | undefined>(undefined);
  protected readonly view = signal<'spec' | 'result'>('spec');
  protected activeTab = 'overview';

  private poll?: Subscription;

  protected readonly working = computed(() => ['New', 'Updated', 'Processing'].includes(this.item()?.status ?? ''));

  protected readonly phases = computed<LifecyclePhase[]>(() => {
    const it = this.item();
    if (!it) {
      return [];
    }
    const s = it.status;
    const ws = it.workerState;
    const r = it.result;
    const hasBaseline = !!r?.baselineAt;
    const queued = s === 'New' || s === 'Updated';
    const scanning = s === 'Processing';
    const watching = s === 'Complete';
    const failed = s === 'Failed';
    const reQueued = s === 'Updated' && hasBaseline;

    return [
      { label: 'Created', subtitle: this.fmt(it.createdAt), state: 'done' },
      {
        label: 'Queued',
        subtitle: queued
          ? (ws?.nextAttemptAt ? `Next attempt ${this.fmt(ws.nextAttemptAt)}` : 'Waiting for the worker to pick it up')
          : 'Picked up by the worker',
        state: queued ? 'now' : 'done',
      },
      {
        label: 'Baseline scan',
        subtitle: scanning ? (it.subStatus || `Attempt ${(ws?.retryCount ?? 0) + 1}`)
          : failed ? (it.subStatus || ws?.lastFailedCode || it.faults?.[0] || 'Failed — see faults')
          : hasBaseline ? `Baseline ${this.fmt(r?.baselineAt)} — ${r?.scriptCount ?? 0} Worker(s)`
          : 'Verify the token, list Workers and their live deployments',
        state: failed ? 'fail' : scanning ? 'now' : hasBaseline ? 'done' : 'todo',
      },
      {
        label: 'Watching',
        subtitle: watching
          ? (r?.lastError ? `Last scan failed ${this.fmt(r?.lastScannedAt)}` : `Scanned ${this.fmt(r?.lastScannedAt || ws?.lastVerifiedAt)} · every 5 min`)
          : reQueued ? 'Spec changed — re-applying'
          : 'Rescans every 5 minutes for deploys, new and deleted Workers',
        state: watching ? (r?.lastError ? 'warn' : 'done') : reQueued ? 'warn' : 'todo',
      },
    ];
  });

  protected readonly attached = computed<RailFact[]>(() => {
    const it = this.item();
    const ws = it?.workerState;
    return [
      { label: 'Workers', value: it?.result?.scriptCount ?? 0 },
      { label: 'Changes', value: it?.result?.events?.length ?? 0 },
      { label: 'Retries', value: ws?.retryCount ?? 0 },
      { label: 'Last verified', value: this.fmt(ws?.lastVerifiedAt) },
    ];
  });

  protected readonly callout = computed<RailCallout | null>(() => {
    const it = this.item();
    if (it?.status === 'Failed' && it.workerState?.lastFailedCode) {
      return { text: 'Last attempt failed', detail: it.workerState.lastFailedCode, tone: 'warn', icon: 'alert-triangle' };
    }
    if (it?.result?.lastError) {
      return { text: 'Last scan failed', detail: it.result.lastError, tone: 'warn', icon: 'alert-triangle' };
    }
    return null;
  });

  ngOnInit(): void {
    this.refresh();
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  /** GET + a 3s poll while the worker is applying; stops once watching/failed. */
  private refresh(): void {
    const id = this.route.snapshot.params['id'];
    this.svc.get(id).subscribe(i => {
      const first = !this.item();
      this.item.set(i);
      if (first) {
        this.view.set(i?.result?.baselineAt ? 'result' : 'spec');
      }
      if (this.working() && !this.poll) {
        this.poll = interval(3000).subscribe(() => this.refresh());
      }
      if (!this.working() && this.poll) {
        this.poll.unsubscribe();
        this.poll = undefined;
      }
    });
  }

  protected label(e: WorkerEvent): string {
    return e.kind === 'ScriptAdded' ? 'Added' : e.kind === 'ScriptDeleted' ? 'Deleted' : e.kind;
  }

  protected short(id?: string): string {
    return id ? id.slice(0, 8) : '—';
  }

  protected fmt(v?: string): string {
    return v ? formatDate(v, 'medium', this.locale) : '—';
  }

  protected edit(): void {
    const it = this.item();
    if (it) {
      this.router.navigate(['../..', 'edit', it.id], { relativeTo: this.route });
    }
  }
}
