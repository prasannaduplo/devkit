import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonLibComponentsModule, FlatStatusFilter } from '@duplocloud-internal/ng-common-lib';
import { RdsUpgradeService, RdsUpgrade } from '../rds-upgrade.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';

// Detail view mirroring the platform resource pattern (network-baselines / TFDeployment):
//  • view-header-card with avatar-badge title + an Actions dropdown + a Spec/Result toggle (app-flat-status-filter);
//  • @switch on activePanel → Spec cards | a step-history timeline (v1 keeps this local/plain rather than
//    wiring the declarative resources-frontend-templates JSON — see EXTENSION_BACKLOG.md #36 for the v2 list);
//  • a footer with the agent's subStatus + a "Track Provisioning Status" button.
@Component({
  selector: 'rds-view',
  imports: [CommonLibComponentsModule, StatusBadgeComponent],
  styles: [`
    .step-row { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.5rem 0; border-left: 2px solid #e0e0e0; margin-left: 0.5rem; padding-left: 1rem; }
    .step-row:last-child { border-left-color: transparent; }
    .step-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 0.35rem; margin-left: -1.35rem; flex-shrink: 0; }
    .step-dot.OK { background: #28c76f; }
    .step-dot.InProgress { background: #ff9f43; }
    .step-dot.Failed { background: #ea5455; }
    .step-dot.Warning { background: #ff9f43; }
  `],
  template: `
    @if (item(); as it) {
      <view-with-sidecards>
        <view-header-card [compactActions]="true">
          <ng-template #title>
            <h3 class="text-uppercase mr-auto">
              <span class="badge avatar-badge">{{ it.name?.[0] }}</span>
              <span class="name-badge">{{ it.name }}</span>
            </h3>
          </ng-template>

          <ng-template #actions>
            <a ngbDropdownItem (click)="edit()"><i data-feather="edit"></i> Edit</a>
            <a ngbDropdownItem (click)="track()"><i data-feather="terminal"></i> View Provisioning Ticket</a>
          </ng-template>

          <ng-template #headerFilter>
            <app-flat-status-filter
              [filters]="panelFilters"
              [activeStatus]="activePanel()"
              [showCount]="false"
              (changed)="activePanel.set($event)">
            </app-flat-status-filter>
          </ng-template>
        </view-header-card>

        <sidecard featherIcon="activity">
          <h6 class="card-subtitle text-muted">Status</h6>
          <h4 class="card-title"><app-status-badge [status]="it.status"></app-status-badge></h4>
        </sidecard>
        <sidecard featherIcon="git-branch">
          <h6 class="card-subtitle text-muted">Phase</h6>
          <h4 class="card-title">{{ it.result?.phase || '—' }}</h4>
        </sidecard>
        <sidecard featherIcon="calendar">
          <h6 class="card-subtitle text-muted">Created At</h6>
          <h4 class="card-title">{{ it.createdAt | date:'medium' }}</h4>
        </sidecard>

        <section class="card px-2 py-1">
          @switch (activePanel()) {
            @case ('spec') {
              <div class="p-1">
                <div class="row">
                  <div class="col-md-6"><strong>Instance:</strong> {{ it.spec?.dbInstanceIdentifier || '—' }}</div>
                  <div class="col-md-6"><strong>Region:</strong> {{ it.spec?.region || '—' }}</div>
                  <div class="col-md-6"><strong>Target Engine Version:</strong> {{ it.spec?.targetEngineVersion || '—' }}</div>
                  <div class="col-md-6"><strong>Target Instance Class:</strong> {{ it.spec?.targetInstanceClass || 'source default' }}</div>
                  <div class="col-md-6"><strong>Target Parameter Group:</strong> {{ it.spec?.targetParameterGroupName || 'cloned from source' }}</div>
                  <div class="col-md-6"><strong>Switchover Timeout:</strong> {{ it.spec?.switchoverTimeoutMinutes || 5 }} min</div>
                </div>
              </div>
            }
            @case ('result') {
              <div class="p-1">
                @if (it.result?.errorMessage) {
                  <div class="alert alert-danger">{{ it.result?.errorMessage }}</div>
                }
                <div class="row mb-1">
                  <div class="col-md-6"><strong>Snapshot:</strong> {{ it.result?.snapshotIdentifier || '—' }}</div>
                  <div class="col-md-6"><strong>Blue/Green Deployment:</strong> {{ it.result?.blueGreenDeploymentId || '—' }}</div>
                  <div class="col-md-6"><strong>Green Endpoint:</strong> {{ it.result?.greenEndpoint || '—' }}</div>
                  <div class="col-md-6"><strong>Final Endpoint:</strong> {{ it.result?.finalEndpoint || '—' }}</div>
                  <div class="col-md-6"><strong>Old Instance (removed at cleanup):</strong> {{ it.result?.oldInstanceIdentifier || '—' }}</div>
                </div>
                <h6 class="font-weight-bolder mt-2">Step History</h6>
                @if (!it.result?.stepHistory?.length) {
                  <p class="text-muted">No steps recorded yet.</p>
                }
                @for (step of it.result?.stepHistory; track $index) {
                  <div class="step-row">
                    <div class="step-dot" [class]="step.status"></div>
                    <div>
                      <div><strong>{{ step.phase }}</strong> — {{ step.status }}</div>
                      <div class="text-muted font-small-2">
                        {{ step.startedAt | date:'medium' }}
                        @if (step.completedAt) { → {{ step.completedAt | date:'medium' }} }
                      </div>
                      @if (step.message) { <div class="font-small-3">{{ step.message }}</div> }
                    </div>
                  </div>
                }
              </div>
            }
          }

          <!-- Status footer: subStatus + Track button (network-baselines pattern) -->
          <div class="d-flex justify-content-end align-items-center px-1 pb-1 pt-50">
            @if (it.subStatus) {
              <span class="font-small-3 text-muted mr-75 text-truncate" style="max-width:60%"
                    [title]="it.subStatus">{{ it.subStatus }}</span>
            }
            <button class="btn btn-primary btn-sm" (click)="track()" [disabled]="tracking()">
              <i data-feather="zap" class="mr-50"></i> Track Provisioning Status
            </button>
          </div>
        </section>
      </view-with-sidecards>
    } @else {
      <div class="text-muted p-2">Loading…</div>
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
  protected readonly panelFilters = [
    new FlatStatusFilter({ name: 'spec', label: 'Spec' }),
    new FlatStatusFilter({ name: 'result', label: 'Result' }),
  ];

  ngOnInit(): void {
    const id = this.route.snapshot.params['id'];
    this.svc.get(id).subscribe(i => {
      this.item.set(i);
      this.activePanel.set(i?.result?.stepHistory?.length ? 'result' : 'spec');
    });
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
