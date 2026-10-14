import { Component, DestroyRef, LOCALE_ID, OnInit, computed, inject, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { ConfigMapDemo, ConfigMapService } from '../configmap.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { LifecyclePhase, LifecycleRailComponent, RailFact } from '../shared/lifecycle-rail.component';

// Detail view on the Extension Studio's Template-G shell (reference/19-detail-page.md) for a PASSTHROUGH
// resource: the platform applies the ConfigMap synchronously in the request, so
//  • there is NO provisioning ticket → no "Ask agent" button, no "Track status" in the rail, and no
//    "Needs your input" phase — the ladder is Created → Applying → Applied;
//  • the Result is what the cluster returned (uid) plus the data that was applied.
@Component({
  selector: 'cm-view',
  imports: [CommonLibComponentsModule, StatusBadgeComponent, LifecycleRailComponent],
  styleUrl: '../shared/detail-page.scss',
  template: `
    @if (item(); as it) {
      <div class="ext-detail-page">

        <header class="g-head">
          <span class="g-tile-ic"><i data-feather="settings" size="26"></i></span>
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
              <span class="g-meta-item"><span class="k">Namespace:</span> <span class="mono">{{ it.spec?.namespace || '—' }}</span></span>
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
                  <div class="g-tile"><div class="g-tl">Namespace</div><span class="g-tv"><span class="mono">{{ it.spec?.namespace || '—' }}</span></span></div>
                  <div class="g-tile"><div class="g-tl">Keys</div><span class="g-tv">{{ dataEntries().length }}</span></div>
                  <div class="g-tile"><div class="g-tl">Scope</div><span class="g-tv"><span class="mono trunc">{{ it.spec?.scopeIds?.[0] || '—' }}</span></span></div>
                </div>
              </div>
              <div class="g-sec">
                <div class="g-sec-h"><h3>Data</h3></div>
                <ng-container *ngTemplateOutlet="dataTable"></ng-container>
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
                        <div class="g-sec-h"><h3>Cluster object</h3></div>
                        <div class="g-tiles c3">
                          <div class="g-tile wide">
                            <div class="g-tl">UID</div>
                            <span class="g-tv">
                              <span class="mono trunc">{{ it.result?.uid || '—' }}</span>
                              @if (!it.result?.uid) { <small>Assigned by the cluster once the ConfigMap is applied</small> }
                            </span>
                          </div>
                          <div class="g-tile"><div class="g-tl">Namespace</div><span class="g-tv"><span class="mono">{{ it.spec?.namespace || '—' }}</span></span></div>
                        </div>
                      </div>
                      <div class="g-sec">
                        <div class="g-sec-h"><h3>Applied data</h3></div>
                        <ng-container *ngTemplateOutlet="dataTable"></ng-container>
                      </div>
                    </ng-template>
                  </li>
                </ul>
              </scrollable-nav-tab>
              <div [ngbNavOutlet]="resultNav" class="mt-50"></div>
            }

            <ng-template #dataTable>
              @if (dataEntries().length) {
                <table class="g-kv">
                  <thead><tr><th>Key</th><th>Value</th></tr></thead>
                  <tbody>
                    @for (e of dataEntries(); track e[0]) {
                      <tr><td class="font-weight-bold">{{ e[0] }}</td><td class="mono">{{ e[1] }}</td></tr>
                    }
                  </tbody>
                </table>
              } @else {
                <span class="text-muted">no entries</span>
              }
            </ng-template>
          </section>

          <!-- Passthrough: no ticket, so no Track button — the rail is the timeline + facts only. -->
          <ext-lifecycle-rail [phases]="phases()" [attached]="attached()" />
        </div>
      </div>
    } @else {
      <div class="text-muted p-2">Loading…</div>
    }
  `,
})
export class ViewConfigMapComponent implements OnInit {
  private static readonly READY = ['Complete', 'Updated'];
  private static readonly TEARDOWN = ['DeProvisioning', 'DeprovisionInitiated', 'DeProvisioned', 'DeprovisionFailed'];

  private readonly svc = inject(ConfigMapService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  protected readonly item = signal<ConfigMapDemo | undefined>(undefined);
  protected readonly view = signal<'spec' | 'result'>('spec');
  // ngbNav writes this from a template event — keep it a plain field.
  protected activeTab = 'overview';

  private poll?: Subscription;

  /** The synchronous apply is still in the request window (New/Processing) — rare, but the badge should pulse. */
  protected readonly working = computed(() => {
    const s = this.item()?.status ?? '';
    return !!s && !ViewConfigMapComponent.READY.includes(s) && s !== 'Failed'
      && !ViewConfigMapComponent.TEARDOWN.includes(s);
  });

  protected readonly dataEntries = computed<[string, string][]>(() => Object.entries(this.item()?.spec?.data ?? {}));

  /** Passthrough ladder: Created → Applying → Applied. No agent, so no "Needs your input". */
  protected readonly phases = computed<LifecyclePhase[]>(() => {
    const it = this.item();
    if (!it) {
      return [];
    }
    const ready = ViewConfigMapComponent.READY.includes(it.status);
    const failed = it.status === 'Failed';
    const working = this.working();
    return [
      { label: 'Created', subtitle: this.fmt(it.createdAt), state: 'done' },
      {
        label: 'Applying',
        subtitle: working ? (it.subStatus || 'Writing the ConfigMap to the cluster')
          : failed ? (it.subStatus || it.faults?.[0] || 'Failed — see faults')
          : 'The platform applies the object in the request',
        state: failed ? 'fail' : working ? 'now' : 'done',
      },
      {
        label: 'Applied',
        subtitle: ready ? `${it.result?.uid ? 'uid ' + it.result.uid : 'Live'} · ${this.fmt(it.updatedAt)}` : undefined,
        state: ready ? 'done' : 'todo',
      },
    ];
  });

  protected readonly attached = computed<RailFact[]>(() => {
    const it = this.item();
    return [
      { label: 'Keys', value: this.dataEntries().length },
      { label: 'Namespace', value: it?.spec?.namespace || '—' },
      { label: 'Updated', value: this.fmt(it?.updatedAt) },
    ];
  });

  ngOnInit(): void {
    this.refresh();
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  private refresh(): void {
    const id = this.route.snapshot.params['id'];
    this.svc.get(id).subscribe(i => {
      const first = !this.item();
      this.item.set(i);
      if (first) {
        this.view.set(i?.result?.uid ? 'result' : 'spec');
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
