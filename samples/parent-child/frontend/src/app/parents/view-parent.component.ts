import { Component, DestroyRef, LOCALE_ID, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { formatDate } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import {
  CommonLibComponentsModule,
  FilterTableUtils,
  SearchableDatatableComponent,
  SearchableDatatableModule,
} from '@duplocloud-internal/ng-common-lib';
import { ParentChildService, HelloChild, HelloParent } from '../parentchild.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { LifecyclePhase, LifecycleRailComponent, RailFact } from '../shared/lifecycle-rail.component';

// Parent detail view (Pattern B from reference/08) on the Extension Studio's Template-G shell
// (reference/19-detail-page.md). The Result tab strip is Overview | Children — the children live in a
// <searchable-datatable> with row-links into the nested child route. Agent-mode ladder in the rail, with
// "Track status" inside the Lifecycle card; the ⋮ menu carries Add child + Edit.
@Component({
  selector: 'pc-view-parent',
  imports: [CommonLibComponentsModule, SearchableDatatableModule, StatusBadgeComponent, LifecycleRailComponent],
  styleUrl: '../shared/detail-page.scss',
  template: `
    @if (parent(); as p) {
      <div class="ext-detail-page">

        <header class="g-head">
          <span class="g-tile-ic"><i data-feather="folder" size="26"></i></span>
          <div class="g-head-main">
            <div class="g-head-t">
              <h1>{{ p.name }}</h1>
              <app-status-badge [status]="p.status"></app-status-badge>
              @if (working()) {
                <span class="dots-loader text-warning"><span></span><span></span><span></span></span>
              }
            </div>
            <div class="g-meta">
              @if (p.createdAt) {
                <span class="g-meta-item"><span class="k">Created:</span> {{ p.createdAt | date:'medium' }}</span>
                <span class="sep">·</span>
              }
              <span class="g-meta-item"><span class="k">Title:</span> {{ p.spec?.title || '—' }}</span>
            </div>
          </div>
          <div class="g-actions">
            <div class="seg" role="group" aria-label="View">
              <button type="button" [class.active]="view() === 'spec'" (click)="view.set('spec')">Spec</button>
              <button type="button" [class.active]="view() === 'result'" (click)="view.set('result')">Result</button>
            </div>
            <button type="button" class="btn btn-sm btn-primary" [disabled]="tracking()" (click)="track()">
              <i data-feather="terminal" class="mr-50"></i>Ask agent
            </button>
            <div ngbDropdown container="body" placement="bottom-right">
              <button type="button" class="btn btn-sm hide-arrow" aria-label="More actions" ngbDropdownToggle>
                <i data-feather="more-vertical"></i>
              </button>
              <div ngbDropdownMenu>
                <a ngbDropdownItem (click)="addChild()"><i data-feather="plus" class="mr-50"></i> Add child</a>
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
                  <div class="g-tile wide"><div class="g-tl">Title</div><span class="g-tv">{{ p.spec?.title || '—' }}</span></div>
                  <div class="g-tile"><div class="g-tl">Created</div><span class="g-tv">{{ fmt(p.createdAt) }}</span></div>
                </div>
              </div>
            } @else {
              <scrollable-nav-tab>
                <ul ngbNav #resultNav="ngbNav" class="nav nav-tabs flat-tabs g-tabs" [(activeId)]="activeTab">
                  <li [ngbNavItem]="'overview'">
                    <a ngbNavLink>Overview</a>
                    <ng-template ngbNavContent>
                      @if (p.faults?.length) {
                        <div class="alert alert-danger py-1 px-2 mb-1">
                          @for (f of p.faults; track f) { <div>{{ f }}</div> }
                        </div>
                      }
                      <div class="g-sec">
                        <div class="g-sec-h"><h3>Generated slug</h3></div>
                        <div class="g-tiles c3">
                          <div class="g-tile wide">
                            <div class="g-tl">Slug</div>
                            <span class="g-tv">
                              <span class="mono trunc">{{ p.result?.slug || '—' }}</span>
                              @if (!p.result?.slug) { <small>Derived by the agent once provisioning completes</small> }
                            </span>
                          </div>
                          <div class="g-tile"><div class="g-tl">Children</div><span class="g-tv">{{ allChildren().length }}</span></div>
                        </div>
                      </div>
                    </ng-template>
                  </li>
                  <li [ngbNavItem]="'children'">
                    <a ngbNavLink>Children <span class="tab-count">{{ allChildren().length }}</span></a>
                    <ng-template ngbNavContent>
                      <searchable-datatable [showAdd]="true" addLabel="Add Child" (add)="addChild()"
                                            [rows]="children()" (filter)="childFilterUpdate()" columnMode="force">
                        <ngx-datatable-column name="Name" [flexGrow]="160">
                          <ng-template ngx-datatable-cell-template let-row="row">
                            <a (click)="openChild(row)" class="text-primary font-weight-medium cursor-pointer">{{ row.name }}</a>
                          </ng-template>
                        </ngx-datatable-column>
                        <ngx-datatable-column name="Note" [flexGrow]="200">
                          <ng-template ngx-datatable-cell-template let-row="row">{{ row.spec?.note || '—' }}</ng-template>
                        </ngx-datatable-column>
                        <ngx-datatable-column name="Status" [flexGrow]="110" [maxWidth]="150">
                          <ng-template ngx-datatable-cell-template let-row="row">
                            <app-status-badge [status]="row.status"></app-status-badge>
                          </ng-template>
                        </ngx-datatable-column>
                      </searchable-datatable>
                    </ng-template>
                  </li>
                </ul>
              </scrollable-nav-tab>
              <div [ngbNavOutlet]="resultNav" class="mt-50"></div>
            }
          </section>

          <ext-lifecycle-rail
            [phases]="phases()"
            [attached]="attached()"
            [trackable]="true"
            [trackBusy]="tracking()"
            (track)="track()" />
        </div>
      </div>
    } @else {
      <div class="text-muted p-2">Loading…</div>
    }
  `,
})
export class ViewParentComponent implements OnInit {
  private static readonly WAITING = ['Blocked', 'WaitingForApproval'];
  private static readonly READY = ['Complete', 'Updated'];
  private static readonly TEARDOWN = ['DeProvisioning', 'DeprovisionInitiated', 'DeProvisioned', 'DeprovisionFailed'];

  private readonly svc = inject(ParentChildService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  // The children <searchable-datatable> owns the search box + term; we read its `searchTerm` when filtering.
  private readonly table = viewChild(SearchableDatatableComponent);

  protected readonly parent = signal<HelloParent | undefined>(undefined);
  protected readonly view = signal<'spec' | 'result'>('result');
  protected readonly tracking = signal(false);
  /** ngbNav writes this from a template event, so a plain field repaints fine under OnPush. */
  protected activeTab = 'overview';

  /** Full unfiltered set from the last fetch. */
  protected readonly allChildren = signal<HelloChild[]>([]);
  private readonly childFilterTerm = signal('');
  // Plain string fields or dot-paths only — searchByFields uses lodash `get`; no method calls.
  private readonly childSearchFields = ['name', 'status', 'spec.note'];

  protected readonly children = computed(() => {
    const term = this.childFilterTerm();
    const all = this.allChildren();
    return term ? all.filter(c => FilterTableUtils.searchByFields(c, this.childSearchFields, term)) : all;
  });

  private parentId = '';
  private poll?: Subscription;

  protected readonly working = computed(() => {
    const s = this.parent()?.status ?? '';
    return !!s && !ViewParentComponent.WAITING.includes(s) && !ViewParentComponent.READY.includes(s)
      && s !== 'Failed' && !ViewParentComponent.TEARDOWN.includes(s);
  });

  /** Agent-mode ladder — see samples/helloworld for the annotated version. */
  protected readonly phases = computed<LifecyclePhase[]>(() => {
    const p = this.parent();
    if (!p) {
      return [];
    }
    const s = p.status;
    const waiting = ViewParentComponent.WAITING.includes(s);
    const ready = ViewParentComponent.READY.includes(s);
    const failed = s === 'Failed';
    const working = this.working();
    return [
      { label: 'Created', subtitle: this.fmt(p.createdAt), state: 'done' },
      {
        label: 'Provisioning',
        subtitle: working ? (p.subStatus || 'The agent is working')
          : failed ? (p.subStatus || p.faults?.[0] || 'Failed — see faults')
          : 'The agent derives the slug',
        state: failed ? 'fail' : working ? 'now' : 'done',
      },
      {
        label: 'Needs your input',
        subtitle: waiting
          ? (s === 'WaitingForApproval' ? 'Approval pending' : (p.blockedReason || 'Question pending'))
          : 'The agent asked a question or needs an approval',
        state: waiting ? 'now' : (ready ? 'done' : 'todo'),
        action: waiting ? { label: 'Review', run: () => this.track() } : undefined,
      },
      {
        label: 'Ready',
        subtitle: ready ? `${p.result?.slug ? 'slug ' + p.result.slug : 'Complete'} · ${this.fmt(p.updatedAt)}` : undefined,
        state: ready ? 'done' : 'todo',
      },
    ];
  });

  protected readonly attached = computed<RailFact[]>(() => [
    { label: 'Children', value: this.allChildren().length },
    { label: 'Title', value: this.parent()?.spec?.title || '—' },
    { label: 'Updated', value: this.fmt(this.parent()?.updatedAt) },
  ]);

  ngOnInit(): void {
    this.parentId = this.route.snapshot.params['parentId'];
    this.refresh();
    // This view is opened per-parent via the `parentId` route param — not a workspace-scoped list — so
    // children load once here; no getTenantRefreshTimer subscription is needed.
    this.svc.listChildren(this.parentId).subscribe(c => this.allChildren.set(c ?? []));
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  private refresh(): void {
    this.svc.getParent(this.parentId).subscribe(p => {
      this.parent.set(p);
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

  // The children table's search box emits (filter) on each keystroke; `children` recomputes from the term.
  protected childFilterUpdate(): void {
    this.childFilterTerm.set(this.table()?.searchTerm?.toLowerCase()?.trim() ?? '');
  }

  protected addChild(): void {
    this.router.navigate(['children', 'add'], { relativeTo: this.route });
  }

  // 'view/:parentId' is two URL segments, so climb both before addressing the sibling 'edit/:id'.
  protected edit(): void {
    const p = this.parent();
    if (p) {
      this.router.navigate(['../..', 'edit', p.id], { relativeTo: this.route });
    }
  }

  protected openChild(c: HelloChild): void {
    this.router.navigate(['children', c.id], { relativeTo: this.route });
  }

  protected track(): void {
    const p = this.parent();
    if (!p) {
      return;
    }
    this.tracking.set(true);
    this.svc.parentTicketName(p.id).subscribe({
      next: name => {
        this.tracking.set(false);
        if (!name) {
          return;
        }
        const url = `/ai/service-desk/${this.svc.workspaceId()}/tickets/chat/${name}`;
        this.router.navigateByUrl(url).then(ok => { if (!ok) window.location.assign(url); })
          .catch(() => window.location.assign(url));
      },
      error: () => this.tracking.set(false),
    });
  }
}
