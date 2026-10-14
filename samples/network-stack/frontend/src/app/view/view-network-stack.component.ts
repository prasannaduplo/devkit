import { Component, DestroyRef, LOCALE_ID, OnInit, computed, inject, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom, interval, Subscription } from 'rxjs';
import { extractErrorMessage, CommonLibComponentsModule, DeleteConfirmationModalService } from '@duplocloud-internal/ng-common-lib';
import { NetworkStack, NetworkStackActionEntry, NetworkStackService } from '../network-stack.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';
import { LifecyclePhase, LifecycleRailComponent, RailCallout, RailFact } from '../shared/lifecycle-rail.component';
import { OverviewPanelComponent } from '../shared/overview-panel.component';
import { NetworkPanelComponent } from '../shared/network-panel.component';
import { LogsPanelComponent } from '../shared/logs-panel.component';
import { AskAiPanelComponent } from '../shared/ask-ai-panel.component';

// Detail view — the dev-kit's CUSTOM TABBED RESULTS reference (reference/17-custom-result-views.md) on the
// Extension Studio's Template-G shell (reference/19-detail-page.md):
//  • header WITHOUT a card: icon tile · name + badge (+ working pulse) · Created / Region / CIDR meta ·
//    Spec | Result switcher · primary "Ask agent" · ⋮ (Edit, Delete);
//  • the main card's Result view is an ngbNav strip — Overview | Network | Logs | Ask AI — one standalone
//    panel component per tab, lazily instantiated by ngbNavContent; Ask AI is deliberately LAST (reference/16);
//  • the on-demand Plan / Apply actions are ghost buttons in the HEADER's action row — Template G's
//    resource-action slot — never a heading or bar over the tab strip (Apply stays disabled until a plan
//    has succeeded — mirrored from result.applyAllowed);
//  • the rail's Lifecycle card is THIS resource's ladder — Created → Provisioned → Planned → Awaiting
//    approval → Applied — derived from status + result.actions, with "Track status" inside it;
//  • a 3s poll refreshes the resource while a run is in flight and STOPS at terminal status.
//
// ngbNav's [(activeId)] stays a PLAIN FIELD, not a signal: ngbNav writes it from a template event, so
// a plain field repaints fine under OnPush — don't fight it (see samples/parent-child's view-parent).
@Component({
  selector: 'ns-view',
  imports: [CommonLibComponentsModule, StatusBadgeComponent, LifecycleRailComponent, OverviewPanelComponent,
            NetworkPanelComponent, LogsPanelComponent, AskAiPanelComponent],
  styleUrl: '../shared/detail-page.scss',
  template: `
    @if (item(); as it) {
      <div class="ext-detail-page">

        <header class="g-head">
          <span class="g-tile-ic"><i data-feather="globe" size="26"></i></span>
          <div class="g-head-main">
            <div class="g-head-t">
              <h1>{{ it.name }}</h1>
              <app-status-badge [status]="it.status"></app-status-badge>
              @if (runBusy()) {
                <span class="dots-loader text-warning"><span></span><span></span><span></span></span>
              }
            </div>
            <div class="g-meta">
              @if (it.createdAt) {
                <span class="g-meta-item"><span class="k">Created:</span> {{ it.createdAt | date:'medium' }}</span>
                <span class="sep">·</span>
              }
              <span class="g-meta-item"><span class="k">Region:</span> {{ it.spec?.region || '—' }}</span>
              <span class="sep">·</span>
              <span class="g-meta-item"><span class="k">CIDR:</span> <span class="mono">{{ it.spec?.vpcCidr || '—' }}</span></span>
            </div>
          </div>
          <div class="g-actions">
            <div class="seg" role="group" aria-label="View">
              <button type="button" [class.active]="view() === 'spec'" (click)="view.set('spec')">Spec</button>
              <button type="button" [class.active]="view() === 'result'" (click)="view.set('result')">Result</button>
            </div>
            <!-- Resource actions live HERE as ghost buttons — Template G's "Open in AWS console" slot — never
                 in a heading over the tab strip. The last plan being current with NO diff means applying would
                 be a no-op, so say so instead of offering it. -->
            @if (!runBusy() && it.result?.applyAllowed && it.result?.lastPlanHasDiff === false) {
              <span class="badge badge-light-secondary">Plan found no changes</span>
            }
            <button type="button" class="btn btn-sm g-btn-ghost" (click)="runAction('plan')" [disabled]="runBusy()">
              <i data-feather="search" class="mr-50"></i>Plan
            </button>
            <button type="button" class="btn btn-sm g-btn-ghost" (click)="runAction('apply')"
                    [disabled]="runBusy() || !it.result?.applyAllowed"
                    title="Apply is enabled once a plan has succeeded">
              <i data-feather="play" class="mr-50"></i>Apply
            </button>
            <button type="button" class="btn btn-sm btn-primary" [disabled]="tracking()" (click)="track()">
              <i data-feather="terminal" class="mr-50"></i>Ask agent
            </button>
            <div ngbDropdown container="body" placement="bottom-right">
              <button type="button" class="btn btn-sm hide-arrow" aria-label="More actions" ngbDropdownToggle>
                <i data-feather="more-vertical"></i>
              </button>
              <div ngbDropdownMenu>
                <a ngbDropdownItem (click)="edit()"><i data-feather="edit" class="mr-50"></i> Edit</a>
                <a ngbDropdownItem class="text-danger" (click)="remove()"><i data-feather="trash-2" class="mr-50"></i> Delete</a>
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
                  <div class="g-tile"><div class="g-tl">Region</div><span class="g-tv">{{ it.spec?.region || '—' }}</span></div>
                  <div class="g-tile"><div class="g-tl">VPC CIDR</div><span class="g-tv"><span class="mono">{{ it.spec?.vpcCidr || '—' }}</span></span></div>
                  <div class="g-tile"><div class="g-tl">DNS hostnames</div><span class="g-tv">{{ it.spec?.enableDnsHostnames ? 'Enabled' : 'Disabled' }}</span></div>
                  <div class="g-tile wide"><div class="g-tl">Scope</div><span class="g-tv"><span class="mono trunc">{{ it.spec?.scopeIds?.[0] || '—' }}</span></span></div>
                  <div class="g-tile"><div class="g-tl">Subnets</div><span class="g-tv">{{ it.spec?.subnets?.length || 0 }}</span></div>
                </div>
              </div>
              @if (it.spec?.subnets?.length) {
                <div class="g-sec">
                  <div class="g-sec-h"><h3>Subnets</h3></div>
                  <table class="g-kv">
                    <thead><tr><th>Name</th><th>CIDR</th><th>AZ</th></tr></thead>
                    <tbody>
                      @for (s of it.spec?.subnets ?? []; track $index) {
                        <tr><td class="font-weight-bold">{{ s.name || '—' }}</td><td class="mono">{{ s.cidr || '—' }}</td><td>{{ s.az || '—' }}</td></tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            } @else {
              <!-- The tab strip is the FIRST thing in the Result view — no heading above it, exactly like the
                   Studio page (reference/17). A failed action trigger surfaces as an alert, not a label.
                   Ask AI is deliberately LAST (reference/16). -->
              @if (actionError(); as err) {
                <div class="alert alert-danger py-1 px-2 mb-1 mt-1">{{ err }}</div>
              }
              <scrollable-nav-tab>
                <ul ngbNav #resultNav="ngbNav" class="nav nav-tabs flat-tabs g-tabs" [(activeId)]="activeTab">
                  <li [ngbNavItem]="'overview'">
                    <a ngbNavLink>Overview</a>
                    <ng-template ngbNavContent>
                      <ns-overview-panel [item]="it" />
                    </ng-template>
                  </li>
                  <li [ngbNavItem]="'network'">
                    <a ngbNavLink>Network <span class="tab-count">{{ it.result?.subnetIds?.length || it.spec?.subnets?.length || 0 }}</span></a>
                    <ng-template ngbNavContent>
                      <ns-network-panel [item]="it" />
                    </ng-template>
                  </li>
                  <li [ngbNavItem]="'logs'">
                    <a ngbNavLink>Logs</a>
                    <ng-template ngbNavContent>
                      <ns-logs-panel [item]="it" />
                    </ng-template>
                  </li>
                  <li [ngbNavItem]="'ask-ai'">
                    <a ngbNavLink>Ask AI</a>
                    <ng-template ngbNavContent>
                      <ns-ask-ai-panel [resource]="it" />
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
            [callout]="callout()"
            [trackable]="true"
            [trackBusy]="tracking()"
            (track)="track()" />
        </div>
      </div>
    } @else {
      <div class="p-2" [class.text-muted]="!loadError()" [class.text-danger]="!!loadError()">
        {{ loadError() || 'Loading…' }}
      </div>
    }
  `,
})
export class ViewNetworkStackComponent implements OnInit {
  // DeprovisionFailed is terminal too — omitting it means a permanent poll + permanently disabled actions.
  private static readonly TERMINAL = ['Complete', 'Failed', 'DeProvisioned', 'DeprovisionFailed', 'Blocked', 'WaitingForApproval'];
  private static readonly WAITING = ['Blocked', 'WaitingForApproval'];

  private readonly svc = inject(NetworkStackService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly deleteModal = inject(DeleteConfirmationModalService);
  private readonly locale = inject(LOCALE_ID);

  protected readonly item = signal<NetworkStack | undefined>(undefined);
  protected readonly view = signal<'result' | 'spec'>('result');
  protected readonly tracking = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly loadError = signal<string | null>(null);

  // ngbNav writes this from a template event — keep it a plain field (see the header comment).
  protected activeTab = 'overview';

  /**
   * A requested action the agent hasn't picked up yet: spec.lastRequestedAction is stamped by the trigger
   * endpoint, and a run "consumes" it by writing an actions[] entry with the same (server-stamped)
   * requestedAt. While pending, the buttons stay disabled — a second click would OVERWRITE the request —
   * and the poll keeps running even though status is still terminal. Bounded to 10 min so a dead agent
   * doesn't lock the buttons forever (re-triggering after that deliberately replaces the stale request).
   */
  protected readonly pendingDispatch = computed(() => {
    const it = this.item();
    const req = it?.spec?.lastRequestedAction?.requestedAt;
    if (!req) {
      return false;
    }
    const consumed = (it?.result?.actions ?? []).some(a => a.requestedAt && a.requestedAt >= req);
    if (consumed) {
      return false;
    }
    return Date.now() - new Date(req).getTime() < 600_000;
  });

  /** A run is in flight (or queued for pickup) — disable the action buttons and keep polling. */
  protected readonly runBusy = computed(() => {
    const st = this.item()?.status ?? '';
    return !ViewNetworkStackComponent.TERMINAL.includes(st) || this.pendingDispatch();
  });

  /** Latest run of a given action, from the skill's result.actions log (newest last). */
  private lastRun(action: 'plan' | 'apply'): NetworkStackActionEntry | undefined {
    const runs = this.item()?.result?.actions ?? [];
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].action === action) {
        return runs[i];
      }
    }
    return undefined;
  }

  /**
   * THIS resource's ladder — not a generic status ladder. Provisioned = the initial stack (result.vpcId);
   * Planned / Applied read the run log; "Awaiting approval" is the Blocked/WaitingForApproval gate between
   * them. A plan with unapplied changes turns Planned `warn` — the stale-deploy analogue of the Studio page.
   */
  protected readonly phases = computed<LifecyclePhase[]>(() => {
    const it = this.item();
    if (!it) {
      return [];
    }
    const s = it.status;
    const waiting = ViewNetworkStackComponent.WAITING.includes(s);
    const failed = s === 'Failed';
    const busy = this.runBusy();
    const inFlight = it.spec?.lastRequestedAction?.action;   // which on-demand action the agent is running
    const provisioned = !!it.result?.vpcId;
    const lastPlan = this.lastRun('plan');
    const lastApply = this.lastRun('apply');
    const planPendingApply = !!it.result?.applyAllowed && it.result?.lastPlanHasDiff === true;

    const provisioning = busy && !provisioned && !inFlight;
    const planning = busy && inFlight === 'plan';
    const applying = busy && inFlight === 'apply';

    return [
      { label: 'Created', subtitle: this.fmt(it.createdAt), state: 'done' },
      {
        label: 'Provisioned',
        subtitle: provisioning ? (it.subStatus || 'The agent is creating the stack')
          : failed && !provisioned ? (it.subStatus || it.faults?.[0] || 'Failed — see faults')
          : provisioned ? `VPC ${it.result?.vpcId}` : 'The agent creates the VPC, subnets and security group',
        state: failed && !provisioned ? 'fail' : provisioning ? 'now' : provisioned ? 'done' : 'todo',
      },
      {
        label: 'Planned',
        subtitle: planning ? (it.subStatus || 'terraform plan is running')
          : lastPlan?.status === 'Failed' ? (lastPlan.summary || 'Last plan failed')
          : planPendingApply ? `${lastPlan?.summary || 'Changes pending'} — not yet applied`
          : lastPlan ? `${lastPlan.summary || 'No changes'} · ${this.fmt(lastPlan.finishedAt)}`
          : 'Preview changes before applying them',
        state: planning ? 'now' : lastPlan?.status === 'Failed' ? 'fail' : planPendingApply ? 'warn' : lastPlan ? 'done' : 'todo',
      },
      {
        label: 'Awaiting approval',
        subtitle: waiting
          ? (s === 'WaitingForApproval' ? 'Approval pending' : (it.blockedReason || 'Question pending'))
          : lastApply ? 'Approved' : 'The agent may pause here for confirmation before it applies',
        state: waiting ? 'now' : lastApply ? 'done' : 'todo',
        action: waiting ? { label: 'Review', run: () => this.track() } : undefined,
      },
      {
        label: 'Applied',
        subtitle: applying ? (it.subStatus || 'terraform apply is running')
          : lastApply?.status === 'Failed' ? (lastApply.summary || 'Last apply failed')
          : lastApply ? `${lastApply.summary || 'Applied'} · ${this.fmt(lastApply.finishedAt)}`
          : 'Live AWS networking matches the last plan',
        state: applying ? 'now' : lastApply?.status === 'Failed' ? 'fail' : lastApply ? 'done' : 'todo',
      },
    ];
  });

  protected readonly attached = computed<RailFact[]>(() => {
    const it = this.item();
    return [
      { label: 'Subnets', value: it?.result?.subnetIds?.length || it?.spec?.subnets?.length || 0 },
      { label: 'Modules', value: it?.result?.modules?.length ?? 0 },
      { label: 'Runs', value: it?.result?.actions?.length ?? 0 },
      { label: 'Region', value: it?.spec?.region || '—' },
    ];
  });

  /** Data-derived callout: a successful plan with changes nobody has applied yet. */
  protected readonly callout = computed<RailCallout | null>(() => {
    const it = this.item();
    if (it?.result?.applyAllowed && it.result?.lastPlanHasDiff === true && !this.runBusy()) {
      return {
        text: 'The last plan has changes that are not applied',
        detail: this.lastRun('plan')?.summary,
        tone: 'warn',
        icon: 'git-branch',
      };
    }
    return null;
  });

  private poll?: Subscription;

  ngOnInit(): void {
    this.refresh();
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  /**
   * GET + 3s poll while a run is in flight; the poll STOPS at terminal status (reference/17).
   * After a Plan/Apply trigger there is a WINDOW where status is still terminal — the backend only stamps
   * spec.lastRequestedAction (202); the skill posts Processing when the agent turn starts, seconds to
   * minutes later. pendingDispatch() keeps the poll alive through that window so the flip is observed.
   */
  private refresh(): void {
    const id = this.route.snapshot.params['id'];
    this.svc.get(id).subscribe({
      next: it => {
        this.item.set(it);
        this.loadError.set(null);
        const inFlight = !ViewNetworkStackComponent.TERMINAL.includes(it?.status ?? '');
        const keepAlive = inFlight || this.pendingDispatch();
        if (keepAlive && !this.poll) {
          this.poll = interval(3000).subscribe(() => this.refresh());
        }
        if (!keepAlive && this.poll) {
          this.poll.unsubscribe();
          this.poll = undefined;
        }
      },
      error: () => {
        // On a FIRST-load failure no poll exists yet, so nothing would ever retry — start one and say
        // so instead of sticking on "Loading…" forever. Later failures ride the existing poll.
        this.loadError.set('Failed to load — retrying…');
        if (!this.poll) {
          this.poll = interval(3000).subscribe(() => this.refresh());
        }
      },
    });
  }

  protected fmt(v?: string): string {
    return v ? formatDate(v, 'medium', this.locale) : '—';
  }

  protected runAction(action: 'plan' | 'apply'): void {
    const it = this.item();
    if (!it) {
      return;
    }
    this.actionError.set(null);
    this.svc.triggerAction(it.id, action).subscribe({
      // The refetched resource carries the stamped spec.lastRequestedAction → pendingDispatch() turns on,
      // which disables the buttons (no overwriting the queued request) and keeps the poll alive.
      next: () => this.refresh(),
      error: e => this.actionError.set(extractErrorMessage(e) || `Could not start the ${action}.`),
    });
  }

  /** Same two-step lifecycle as the list's Delete (reference/11); back to the list on success. */
  protected remove(): void {
    const it = this.item();
    if (!it) {
      return;
    }
    const st = (it.status || '').toLowerCase();
    const hardDelete = ['new', 'failed', 'deprovisioned'].includes(st) && !it.result?.vpcId;
    const deprovision = !hardDelete && ['complete', 'failed', 'deprovisionfailed', 'waitingforapproval'].includes(st);
    if (!hardDelete && !deprovision) {
      this.actionError.set(`"${it.name}" is ${it.status} — wait for the current run to finish before deleting it.`);
      return;
    }
    const action = () => firstValueFrom(hardDelete ? this.svc.remove(it.id) : this.svc.deprovision(it.id))
      .then(() => this.router.navigate(['../..'], { relativeTo: this.route }))
      .catch(e => { this.actionError.set(extractErrorMessage(e) || 'Delete failed.'); throw e; });
    try {
      this.deleteModal.openGeneric('Network Stack', it.name, action, undefined, hardDelete ? 'Delete' : 'Deprovision');
    } catch {
      if (window.confirm(`Delete network stack "${it.name}"?`)) { action().catch(() => undefined); }
    }
  }

  protected edit(): void {
    const it = this.item();
    if (it) {
      this.router.navigate(['../..', 'edit', it.id], { relativeTo: this.route });
    }
  }

  /** Open the provisioning ticket — "Ask agent" (header) and "Track status" (rail) both land here. */
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
        // Host routes can no-op from a remote — fall back to a hard navigation (reference/16 pitfalls).
        const url = `/ai/service-desk/${this.svc.workspaceId()}/tickets/chat/${name}`;
        this.router.navigateByUrl(url).then(ok => { if (!ok) window.location.assign(url); })
          .catch(() => window.location.assign(url));
      },
      error: () => this.tracking.set(false),
    });
  }
}
