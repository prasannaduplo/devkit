import { Component, DestroyRef, LOCALE_ID, OnInit, computed, inject, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { ParentChildService, HelloChild } from '../parentchild.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { LifecyclePhase, LifecycleRailComponent, RailFact } from '../shared/lifecycle-rail.component';

// Child detail view on the Extension Studio's Template-G shell (reference/19-detail-page.md). Same
// Agent-mode ladder as the parent (Created → Provisioning → Needs your input → Ready); the header's ⋮ menu
// adds "Back to parent" because this route nests under `view/:parentId/children/:childId`.
@Component({
  selector: 'pc-view-child',
  imports: [CommonLibComponentsModule, StatusBadgeComponent, LifecycleRailComponent],
  styleUrl: '../shared/detail-page.scss',
  template: `
    @if (child(); as c) {
      <div class="ext-detail-page">

        <header class="g-head">
          <span class="g-tile-ic"><i data-feather="file-text" size="26"></i></span>
          <div class="g-head-main">
            <div class="g-head-t">
              <h1>{{ c.name }}</h1>
              <app-status-badge [status]="c.status"></app-status-badge>
              @if (working()) {
                <span class="dots-loader text-warning"><span></span><span></span><span></span></span>
              }
            </div>
            <div class="g-meta">
              @if (c.createdAt) {
                <span class="g-meta-item"><span class="k">Created:</span> {{ c.createdAt | date:'medium' }}</span>
                <span class="sep">·</span>
              }
              <span class="g-meta-item"><span class="k">Parent:</span> <span class="mono">{{ c.spec?.parentId || parentId }}</span></span>
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
                <a ngbDropdownItem (click)="back()"><i data-feather="arrow-left" class="mr-50"></i> Back to parent</a>
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
                  <div class="g-tile wide"><div class="g-tl">Note</div><span class="g-tv">{{ c.spec?.note || '—' }}</span></div>
                  <div class="g-tile"><div class="g-tl">Parent</div><span class="g-tv"><span class="mono trunc">{{ c.spec?.parentId || parentId }}</span></span></div>
                </div>
              </div>
            } @else {
              <scrollable-nav-tab>
                <ul ngbNav #resultNav="ngbNav" class="nav nav-tabs flat-tabs g-tabs" [(activeId)]="activeTab">
                  <li [ngbNavItem]="'overview'">
                    <a ngbNavLink>Overview</a>
                    <ng-template ngbNavContent>
                      @if (c.faults?.length) {
                        <div class="alert alert-danger py-1 px-2 mb-1">
                          @for (f of c.faults; track f) { <div>{{ f }}</div> }
                        </div>
                      }
                      <div class="g-sec">
                        <div class="g-sec-h"><h3>Agent's message</h3></div>
                        <div class="g-tiles c3">
                          <div class="g-tile wide">
                            <div class="g-tl">Message</div>
                            <span class="g-tv">
                              {{ c.result?.message || '—' }}
                              @if (!c.result?.message) { <small>Written by the agent once provisioning completes</small> }
                            </span>
                          </div>
                          <div class="g-tile"><div class="g-tl">Status</div><span class="g-tv"><app-status-badge [status]="c.status"></app-status-badge></span></div>
                        </div>
                      </div>
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
export class ViewChildComponent implements OnInit {
  private static readonly WAITING = ['Blocked', 'WaitingForApproval'];
  private static readonly READY = ['Complete', 'Updated'];
  private static readonly TEARDOWN = ['DeProvisioning', 'DeprovisionInitiated', 'DeProvisioned', 'DeprovisionFailed'];

  private readonly svc = inject(ParentChildService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  protected readonly child = signal<HelloChild | undefined>(undefined);
  protected readonly view = signal<'spec' | 'result'>('spec');
  protected readonly tracking = signal(false);
  // ngbNav writes this from a template event — keep it a plain field.
  protected activeTab = 'overview';

  protected parentId = '';
  private poll?: Subscription;

  protected readonly working = computed(() => {
    const s = this.child()?.status ?? '';
    return !!s && !ViewChildComponent.WAITING.includes(s) && !ViewChildComponent.READY.includes(s)
      && s !== 'Failed' && !ViewChildComponent.TEARDOWN.includes(s);
  });

  /** Agent-mode ladder — see samples/helloworld for the annotated version. */
  protected readonly phases = computed<LifecyclePhase[]>(() => {
    const c = this.child();
    if (!c) {
      return [];
    }
    const s = c.status;
    const waiting = ViewChildComponent.WAITING.includes(s);
    const ready = ViewChildComponent.READY.includes(s);
    const failed = s === 'Failed';
    const working = this.working();
    return [
      { label: 'Created', subtitle: `${this.fmt(c.createdAt)} · under parent`, state: 'done' },
      {
        label: 'Provisioning',
        subtitle: working ? (c.subStatus || 'The agent is working')
          : failed ? (c.subStatus || c.faults?.[0] || 'Failed — see faults')
          : 'The agent writes the child’s message',
        state: failed ? 'fail' : working ? 'now' : 'done',
      },
      {
        label: 'Needs your input',
        subtitle: waiting
          ? (s === 'WaitingForApproval' ? 'Approval pending' : (c.blockedReason || 'Question pending'))
          : 'The agent asked a question or needs an approval',
        state: waiting ? 'now' : (ready ? 'done' : 'todo'),
        action: waiting ? { label: 'Review', run: () => this.track() } : undefined,
      },
      {
        label: 'Ready',
        subtitle: ready ? `${c.result?.message ? 'Message written' : 'Complete'} · ${this.fmt(c.updatedAt)}` : undefined,
        state: ready ? 'done' : 'todo',
      },
    ];
  });

  protected readonly attached = computed<RailFact[]>(() => {
    const c = this.child();
    return [
      { label: 'Parent', value: c?.spec?.parentId || this.parentId || '—' },
      { label: 'Updated', value: this.fmt(c?.updatedAt) },
    ];
  });

  ngOnInit(): void {
    this.parentId = this.route.snapshot.params['parentId'];
    this.refresh();
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  private refresh(): void {
    const childId = this.route.snapshot.params['childId'];
    this.svc.getChild(this.parentId, childId).subscribe(c => {
      const first = !this.child();
      this.child.set(c);
      if (first) {
        this.view.set(c?.result?.message ? 'result' : 'spec');
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

  // This route is `view/:parentId/children/:childId`; one pop then `edit/:childId` builds the sibling
  // edit URL `view/:parentId/children/edit/:childId`.
  protected edit(): void {
    const c = this.child();
    if (c) {
      this.router.navigate(['..', 'edit', c.id], { relativeTo: this.route });
    }
  }

  protected track(): void {
    const c = this.child();
    if (!c) {
      return;
    }
    this.tracking.set(true);
    this.svc.childTicketName(c.id).subscribe({
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

  protected back(): void {
    this.router.navigate(['../..'], { relativeTo: this.route });
  }
}
