import { Component, computed, input } from '@angular/core';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { NetworkStack } from '../network-stack.service';
import { StatusBadgeComponent } from './status-badge.component';

// Overview tab body on the Template-G tile grammar (reference/19-detail-page.md): `.g-sec` sections of
// `.g-tile`s for the stack's headline facts, then per-module progress and the recent runs.
// NEVER a dead empty state — until the result lands, the PLANNED values from the spec render, so the
// page is meaningful from the second the resource is created (reference/17-custom-result-views.md).
@Component({
  selector: 'ns-overview-panel',
  imports: [CommonLibComponentsModule, StatusBadgeComponent],
  styleUrl: './detail-page.scss',
  template: `
    @if (item(); as it) {
      @if (it.faults?.length) {
        <div class="alert alert-danger py-1 px-2 mb-1">
          @for (f of it.faults; track f) { <div>{{ f }}</div> }
        </div>
      }

      <div class="g-sec">
        <div class="g-sec-h"><h3>Network</h3></div>
        <div class="g-tiles c3">
          <div class="g-tile">
            <div class="g-tl">VPC</div>
            <span class="g-tv">
              <span class="mono trunc">{{ it.result?.vpcId || it.spec?.vpcCidr || '—' }}</span>
              @if (!it.result?.vpcId) { <small>planned — created on the first apply</small> }
            </span>
          </div>
          <div class="g-tile">
            <div class="g-tl">Subnets</div>
            <span class="g-tv">{{ subnetSummary() }}</span>
          </div>
          <div class="g-tile">
            <div class="g-tl">Security group</div>
            <span class="g-tv">
              <span class="mono trunc">{{ it.result?.securityGroupId || 'default' }}</span>
              @if (!it.result?.securityGroupId) { <small>egress-only, planned</small> }
            </span>
          </div>
        </div>
      </div>

      <div class="g-sec">
        <div class="g-sec-h"><h3>Modules</h3></div>
        <div class="g-tiles c3">
          @for (m of modules(); track m.key) {
            <div class="g-tile">
              <div class="g-tl">{{ m.label }}</div>
              <span class="g-tv"><app-status-badge [status]="m.status"></app-status-badge></span>
            </div>
          }
        </div>
      </div>

      @if (it.result?.actions?.length) {
        <div class="g-sec">
          <div class="g-sec-h"><h3>Recent runs</h3></div>
          <table class="g-kv">
            <thead><tr><th>Action</th><th>Summary</th><th>By</th><th>Status</th></tr></thead>
            <tbody>
              @for (a of recentActions(); track a.runId ?? a.requestedAt) {
                <tr>
                  <td class="font-weight-bold text-capitalize">{{ a.action }}</td>
                  <td>{{ a.summary || '—' }}</td>
                  <td class="text-muted">{{ a.requestedBy || '—' }}</td>
                  <td><app-status-badge [status]="a.status"></app-status-badge></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    }
  `,
})
export class OverviewPanelComponent {
  readonly item = input.required<NetworkStack>();

  // computed(), not getters: recompute only when the input changes (OnPush-safe, no per-CD churn).
  protected readonly subnetSummary = computed(() => {
    const it = this.item();
    const live = it.result?.subnetIds;
    if (live?.length) return `${live.length} created`;
    const planned = it.spec?.subnets ?? [];
    return planned.length ? `${planned.length} planned` : '—';
  });

  /** Module rows — synthesized as NotStarted from the fixed module set until the skill's first post. */
  protected readonly modules = computed(() => {
    const posted = this.item().result?.modules;
    if (posted?.length) return posted;
    return [
      { key: 'vpc', label: 'VPC', status: 'NotStarted' },
      { key: 'subnets', label: 'Subnets', status: 'NotStarted' },
      { key: 'security', label: 'Security Group', status: 'NotStarted' },
    ];
  });

  protected readonly recentActions = computed(() =>
    [...(this.item().result?.actions ?? [])].reverse().slice(0, 5));
}
