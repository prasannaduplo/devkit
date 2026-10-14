import { Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  DeleteConfirmationModalService, FilterTableUtils, SearchableDatatableComponent, SearchableDatatableModule,
  extractErrorMessage,
} from '@duplocloud-internal/ng-common-lib';
import { NetworkStack, NetworkStackService, REMOTE_UserSession } from '../network-stack.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';

// List view on the platform's <searchable-datatable> (helloworld pattern) — search, paging and the
// actions dropdown come for free; columns are projected as <ngx-datatable-column> children.
@Component({
  selector: 'ns-list',
  imports: [SearchableDatatableModule, StatusBadgeComponent],
  template: `
    <div class="card datatable-card">
      <!-- Page-level error surface: fetch/delete failures must be visible, not a silent empty table. -->
      @if (error(); as e) {
        <div class="alert alert-danger d-flex align-items-center m-1 mb-0 p-75">
          <span class="mr-auto">{{ e }}</span>
          <button type="button" class="close ml-1" aria-label="Dismiss" (click)="error.set('')">
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
      }
      <searchable-datatable
        [showAdd]="true"
        addLabel="Create Network Stack"
        (add)="add()"
        [rows]="rows()"
        (filter)="filterUpdate()"
        columnMode="force">

        <!-- Actions -->
        <ngx-datatable-column [width]="50" [sortable]="false" [canAutoResize]="false" cellClass="actions">
          <ng-template ngx-datatable-cell-template let-row="row">
            <div ngbDropdown container="body">
              <button class="btn btn-sm hide-arrow" ngbDropdownToggle>
                <i data-feather="more-vertical"></i>
              </button>
              <div ngbDropdownMenu>
                <a ngbDropdownItem (click)="view(row)">
                  <i data-feather="eye" class="mr-50"></i><span>View</span>
                </a>
                <a ngbDropdownItem (click)="edit(row)">
                  <i data-feather="edit" class="mr-50"></i><span>Edit</span>
                </a>
                <a ngbDropdownItem (click)="track(row)">
                  <i data-feather="activity" class="mr-50"></i><span>Track Provisioning</span>
                </a>
                <a ngbDropdownItem class="text-danger" (click)="remove(row)">
                  <i data-feather="trash-2" class="mr-50"></i><span>Delete</span>
                </a>
              </div>
            </div>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Name" [flexGrow]="150">
          <ng-template ngx-datatable-cell-template let-row="row">
            <a (click)="view(row)" class="text-primary font-weight-medium cursor-pointer">{{ row.name }}</a>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Region" [flexGrow]="100">
          <ng-template ngx-datatable-cell-template let-row="row">{{ row.spec?.region || '—' }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="VPC CIDR" [flexGrow]="110">
          <ng-template ngx-datatable-cell-template let-row="row">{{ row.spec?.vpcCidr || '—' }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="VPC" [flexGrow]="150">
          <ng-template ngx-datatable-cell-template let-row="row">{{ row.result?.vpcId || '—' }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Status" [flexGrow]="110" [maxWidth]="150">
          <ng-template ngx-datatable-cell-template let-row="row">
            <app-status-badge [status]="row.status"></app-status-badge>
          </ng-template>
        </ngx-datatable-column>

      </searchable-datatable>
    </div>
  `,
})
export class ListNetworkStackComponent implements OnInit {
  private readonly svc = inject(NetworkStackService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject<any>(REMOTE_UserSession as any);
  private readonly destroyRef = inject(DestroyRef);

  private readonly deleteModal = inject(DeleteConfirmationModalService);

  private readonly table = viewChild(SearchableDatatableComponent);

  private readonly allRows = signal<NetworkStack[]>([]);
  private readonly filterTerm = signal('');
  protected readonly error = signal('');

  private readonly searchFields = ['name', 'status', 'spec.region', 'spec.vpcCidr', 'result.vpcId'];

  protected readonly rows = computed(() => {
    const term = this.filterTerm();
    const all = this.allRows();
    return term ? all.filter(r => FilterTableUtils.searchByFields(r, this.searchFields, term)) : all;
  });

  ngOnInit(): void {
    this.session.getTenantRefreshTimer(true)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([, tenantChanged]: [any, boolean]) => this.refresh(!!tenantChanged));
  }

  private refresh(tenantChanged: boolean): void {
    if (tenantChanged) {
      this.table()?.startLoading();
    }
    this.svc.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: rows => {
        this.allRows.set(rows ?? []);
        this.table()?.refresh();
      },
      error: () => {
        this.allRows.set([]);
        this.table()?.stopLoading();
        this.error.set('Could not load the network stacks — retry on the next refresh, or reload the page.');
      },
    });
  }

  /**
   * Delete is a two-step lifecycle (reference/11): a terminal-but-provisioned row is DEPROVISIONED
   * (terraform destroy on the resource's ticket; the row auto-deletes at DeProvisioned); a
   * never-provisioned/failed row is hard-DELETED. Anything in flight must finish first.
   */
  protected remove(r: NetworkStack): void {
    const st = (r.status || '').toLowerCase();
    const hardDelete = ['new', 'failed', 'deprovisioned'].includes(st) && !r.result?.vpcId;
    const deprovision = !hardDelete && ['complete', 'failed', 'deprovisionfailed', 'waitingforapproval'].includes(st);
    if (!hardDelete && !deprovision) {
      this.error.set(`"${r.name}" is ${r.status} — wait for the current run to finish before deleting it.`);
      return;
    }
    const action = () => firstValueFrom(hardDelete ? this.svc.remove(r.id) : this.svc.deprovision(r.id))
      .then(() => this.refresh(false))
      .catch(e => { this.error.set(extractErrorMessage(e) || 'Delete failed.'); throw e; });
    // Host modal services can throw inside a remote — degrade to the browser confirm, never a dead button.
    try {
      this.deleteModal.openGeneric('Network Stack', r.name, action, undefined, hardDelete ? 'Delete' : 'Deprovision');
    } catch {
      if (window.confirm(`Delete network stack "${r.name}"?`)) { action().catch(() => undefined); }
    }
  }

  protected filterUpdate(): void {
    this.filterTerm.set(this.table()?.searchTerm?.toLowerCase()?.trim() ?? '');
  }

  protected add(): void {
    this.router.navigate(['add'], { relativeTo: this.route });
  }

  protected view(r: NetworkStack): void {
    this.router.navigate(['view', r.id], { relativeTo: this.route });
  }

  protected edit(r: NetworkStack): void {
    this.router.navigate(['edit', r.id], { relativeTo: this.route });
  }

  protected track(r: NetworkStack): void {
    this.svc.ticketName(r.id).subscribe(name => {
      if (!name) {
        return;
      }
      // Host routes can no-op from a remote — fall back to a hard navigation (reference/16 pitfalls).
      const url = `/ai/service-desk/${this.svc.workspaceId()}/tickets/chat/${name}`;
      this.router.navigateByUrl(url).then(ok => { if (!ok) window.location.assign(url); })
        .catch(() => window.location.assign(url));
    });
  }
}
