import { Component, DestroyRef, LOCALE_ID, OnInit, computed, inject, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { Calculator, CalculatorService } from '../calculator.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { LifecyclePhase, LifecycleRailComponent, RailCallout, RailFact } from '../shared/lifecycle-rail.component';

// Detail view on the Extension Studio's Template-G shell (reference/19-detail-page.md) for a WORKER resource
// (pure compute): the background worker reads a + b and writes sum/product, so
//  • there is NO provisioning ticket → no "Ask agent", no "Track status", no "Needs your input" phase;
//  • the ladder is the worker's loop — Created → Queued → Computing → Converged — subtitled from `workerState`;
//  • a spec edit re-queues the worker (status Updated) and Converged turns `warn` until it recomputes.
@Component({
  selector: 'calc-view',
  imports: [CommonLibComponentsModule, StatusBadgeComponent, LifecycleRailComponent],
  styleUrl: '../shared/detail-page.scss',
  template: `
    @if (item(); as it) {
      <div class="ext-detail-page">

        <header class="g-head">
          <span class="g-tile-ic"><i data-feather="hash" size="26"></i></span>
          <div class="g-head-main">
            <div class="g-head-t">
              <h1>{{ it.name }}</h1>
              <app-status-badge [status]="it.status"></app-status-badge>
              @if (working()) {
                <span class="dots-loader text-warning"><span></span><span></span><span></span></span>
              }
            </div>
            <div class="g-meta">
              @if (it.createdAt) {
                <span class="g-meta-item"><span class="k">Created:</span> {{ it.createdAt | date:'medium' }}</span>
                <span class="sep">·</span>
              }
              <span class="g-meta-item"><span class="k">Inputs:</span> <span class="mono">a = {{ it.spec?.a ?? '—' }}, b = {{ it.spec?.b ?? '—' }}</span></span>
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
                <!-- Editing the spec is what re-triggers the worker. -->
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
                  <div class="g-tile"><div class="g-tl">A</div><span class="g-tv">{{ it.spec?.a ?? '—' }}</span></div>
                  <div class="g-tile"><div class="g-tl">B</div><span class="g-tv">{{ it.spec?.b ?? '—' }}</span></div>
                  <div class="g-tile"><div class="g-tl">Created</div><span class="g-tv">{{ fmt(it.createdAt) }}</span></div>
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
                      <div class="g-sec">
                        <div class="g-sec-h"><h3>Computed</h3></div>
                        <div class="g-tiles c3">
                          <div class="g-tile">
                            <div class="g-tl">Sum (a + b)</div>
                            <span class="g-tv">
                              {{ it.result?.sum ?? '—' }}
                              @if (it.result?.sum == null) { <small>Written by the worker on its first pass</small> }
                            </span>
                          </div>
                          <div class="g-tile"><div class="g-tl">Product (a × b)</div><span class="g-tv">{{ it.result?.product ?? '—' }}</span></div>
                          <div class="g-tile"><div class="g-tl">Inputs</div><span class="g-tv"><span class="mono">{{ it.spec?.a ?? '—' }}, {{ it.spec?.b ?? '—' }}</span></span></div>
                        </div>
                      </div>
                    </ng-template>
                  </li>
                </ul>
              </scrollable-nav-tab>
              <div [ngbNavOutlet]="resultNav" class="mt-50"></div>
            }
          </section>

          <!-- Worker: no ticket, so no Track button. -->
          <ext-lifecycle-rail [phases]="phases()" [attached]="attached()" [callout]="callout()" attachedTitle="Worker" />
        </div>
      </div>
    } @else {
      <div class="text-muted p-2">Loading…</div>
    }
  `,
})
export class ViewCalculatorComponent implements OnInit {
  private readonly svc = inject(CalculatorService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  protected readonly item = signal<Calculator | undefined>(undefined);
  protected readonly view = signal<'spec' | 'result'>('spec');
  // ngbNav writes this from a template event — keep it a plain field.
  protected activeTab = 'overview';

  private poll?: Subscription;

  /** Worker loop in progress: queued (New/Updated) or mid-compute (Processing). */
  protected readonly working = computed(() => ['New', 'Updated', 'Processing'].includes(this.item()?.status ?? ''));

  /** The worker's loop as a timeline; subtitles come from `workerState` (the only audit trail a worker has). */
  protected readonly phases = computed<LifecyclePhase[]>(() => {
    const it = this.item();
    if (!it) {
      return [];
    }
    const s = it.status;
    const ws = it.workerState;
    const hasResult = it.result?.sum != null;
    const queued = s === 'New' || s === 'Updated';
    const computing = s === 'Processing';
    const converged = s === 'Complete';
    const failed = s === 'Failed';
    const reQueued = s === 'Updated' && hasResult;   // computed before; inputs changed since

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
        label: 'Computing',
        subtitle: computing ? (it.subStatus || `Attempt ${(ws?.retryCount ?? 0) + 1}`)
          : failed ? (it.subStatus || ws?.lastFailedCode || it.faults?.[0] || 'Failed — see faults')
          : converged || reQueued ? `Last attempt ${this.fmt(ws?.lastAttemptAt)}`
          : 'The worker reads a + b and writes sum / product',
        state: failed ? 'fail' : computing ? 'now' : (converged || reQueued) ? 'done' : 'todo',
      },
      {
        label: 'Converged',
        subtitle: converged ? `Verified ${this.fmt(ws?.lastVerifiedAt || it.updatedAt)}`
          : reQueued ? 'Inputs changed — result is stale until the worker recomputes'
          : 'Result matches the current inputs',
        state: converged ? 'done' : reQueued ? 'warn' : 'todo',
      },
    ];
  });

  protected readonly attached = computed<RailFact[]>(() => {
    const ws = this.item()?.workerState;
    return [
      { label: 'Retries', value: ws?.retryCount ?? 0 },
      { label: 'Last attempt', value: this.fmt(ws?.lastAttemptAt) },
      { label: 'Last verified', value: this.fmt(ws?.lastVerifiedAt) },
    ];
  });

  protected readonly callout = computed<RailCallout | null>(() => {
    const it = this.item();
    if (it?.status === 'Failed' && it.workerState?.lastFailedCode) {
      return { text: 'Last attempt failed', detail: it.workerState.lastFailedCode, tone: 'warn', icon: 'alert-triangle' };
    }
    return null;
  });

  ngOnInit(): void {
    this.refresh();
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  /** GET + a 3s poll while the worker is looping, so the active phase moves; stops once converged/failed. */
  private refresh(): void {
    const id = this.route.snapshot.params['id'];
    this.svc.get(id).subscribe(i => {
      const first = !this.item();
      this.item.set(i);
      if (first) {
        this.view.set(i?.result?.sum != null ? 'result' : 'spec');
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

  protected fmt(v?: string): string {
    return v ? formatDate(v, 'medium', this.locale) : '—';
  }

  // 'view/:id' is two URL segments, so climb both before addressing the sibling 'edit/:id'.
  protected edit(): void {
    const it = this.item();
    if (it) {
      this.router.navigate(['../..', 'edit', it.id], { relativeTo: this.route });
    }
  }
}
