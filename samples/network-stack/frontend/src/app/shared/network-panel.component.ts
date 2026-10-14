import { Component, computed, input } from '@angular/core';
import { CommonLibComponentsModule } from '@duplocloud-internal/ng-common-lib';
import { NetworkStack, NetworkStackSubnet } from '../network-stack.service';

// Network tab body: the VPC facts + one row per subnet. Rows merge three sources —
//   planned (spec.subnets) → created (result.subnetIds) → LIVE (result.liveSubnets, injected by the
// backend's EnrichResultAsync on every GET; never persisted — reference/12).
@Component({
  selector: 'ns-network-panel',
  imports: [CommonLibComponentsModule],
  template: `
    @if (item(); as it) {
      <div class="p-1">
        <div class="row mb-1">
          <div class="col-md-4"><strong>Region:</strong> {{ it.spec?.region || '—' }}</div>
          <div class="col-md-4"><strong>VPC CIDR:</strong> {{ it.spec?.vpcCidr || '—' }}</div>
          <div class="col-md-4"><strong>VPC ID:</strong> {{ it.result?.vpcId || 'not created yet' }}</div>
        </div>

        <table class="table table-sm">
          <thead>
            <tr>
              <th>Subnet</th><th>CIDR</th><th>AZ</th><th>Live state</th><th>Available IPs</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.name) {
              <tr>
                <td>{{ row.name }}</td>
                <td class="text-monospace">{{ row.cidr || '—' }}</td>
                <td>{{ row.az || '—' }}</td>
                <td>{{ row.state || (it.result?.vpcId ? '—' : 'planned') }}</td>
                <td>{{ row.availableIps ?? '—' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="text-muted">No subnets in the spec.</td></tr>
            }
          </tbody>
        </table>

        @if (it.result?.vpcId && !it.result?.liveSubnets?.length) {
          <p class="text-muted font-small-3 mb-0">
            Live state unavailable (scope credentials or AWS unreachable) — showing the persisted result.
          </p>
        }
      </div>
    }
  `,
})
export class NetworkPanelComponent {
  readonly item = input.required<NetworkStack>();

  /** One row per planned subnet, overlaid with live state matched by CIDR when enrichment delivered it. */
  protected readonly rows = computed(() => {
    const it = this.item();
    const live = it.result?.liveSubnets ?? [];
    return (it.spec?.subnets ?? []).map((s: NetworkStackSubnet) => {
      const match = live.find(l => l.cidr === s.cidr);
      return {
        name: s.name ?? '—',
        cidr: s.cidr,
        az: match?.availabilityZone ?? s.az,
        state: match?.state,
        availableIps: match?.availableIps,
      };
    });
  });
}
