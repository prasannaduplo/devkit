import { Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ConfirmationModalService, FilterTableUtils, SearchableDatatableComponent, SearchableDatatableModule } from '@duplocloud-internal/ng-common-lib';
import { NetworkMapService, NetworkMap, REMOTE_UserSession } from '../network-map.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';

@Component({
  selector: 'nm-list',
  imports: [SearchableDatatableModule, StatusBadgeComponent],
  template: `
    <div class="card datatable-card">
      <searchable-datatable
        [showAdd]="true"
        addLabel="Create Network Map"
        (add)="add()"
        [rows]="rows()"
        (filter)="filterUpdate()"
        columnMode="force">

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
                <a ngbDropdownItem (click)="deleteRow(row)">
                  <i data-feather="trash-2" class="mr-50"></i><span>Delete</span>
                </a>
              </div>
            </div>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Name" [flexGrow]="140">
          <ng-template ngx-datatable-cell-template let-row="row">
            <a (click)="view(row)" class="text-primary font-weight-medium cursor-pointer">{{ row.name }}</a>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Region" [flexGrow]="90">
          <ng-template ngx-datatable-cell-template let-row="row">{{ row.spec?.region || '—' }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="VPCs" [flexGrow]="70">
          <ng-template ngx-datatable-cell-template let-row="row">{{ row.result?.vpcs?.length ?? 0 }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Resources" [flexGrow]="90">
          <ng-template ngx-datatable-cell-template let-row="row">{{ resourceCount(row) }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Inbound Open" [flexGrow]="140">
          <ng-template ngx-datatable-cell-template let-row="row">
            @if (openCount(row) > 0) {
              <span class="badge badge-light-danger">{{ openCount(row) }} open</span>
            } @else {
              <span class="badge badge-light-success">none found</span>
            }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Status" [flexGrow]="100" [maxWidth]="140">
          <ng-template ngx-datatable-cell-template let-row="row">
            <app-status-badge [status]="row.status"></app-status-badge>
          </ng-template>
        </ngx-datatable-column>

      </searchable-datatable>
    </div>
  `,
})
export class ListNetworkMapComponent implements OnInit {
  private readonly svc = inject(NetworkMapService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject<any>(REMOTE_UserSession as any);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirmation = inject(ConfirmationModalService);

  private readonly table = viewChild(SearchableDatatableComponent);
  private readonly allRows = signal<NetworkMap[]>([]);
  private readonly filterTerm = signal('');
  private readonly searchFields = ['name', 'status', 'spec.region'];

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

  // The collection endpoint (list()) returns whatever's persisted, which for a NEVER-persisted,
  // enrichment-only resource is empty -- EnrichResultAsync only runs on a single-resource GET (see
  // NetworkMapService's comment). So the list re-fetches each row by id to get the live-scanned VPCs/
  // endpoints. Fine in practice: a workspace has at most a handful of these (one per account/region), and
  // every other view in this extension already re-scans live on every load the same way.
  private refresh(tenantChanged: boolean): void {
    if (tenantChanged) {
      this.table()?.startLoading();
    }
    this.svc.list().pipe(
      switchMap(rows => (rows?.length ? forkJoin(rows.map(r => this.svc.get(r.id))) : of([] as NetworkMap[]))),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: rows => {
        this.allRows.set(rows ?? []);
        this.table()?.refresh();
      },
      error: () => {
        this.allRows.set([]);
        this.table()?.stopLoading();
      },
    });
  }

  protected filterUpdate(): void {
    this.filterTerm.set(this.table()?.searchTerm?.toLowerCase()?.trim() ?? '');
  }

  protected openCount(row: NetworkMap): number {
    return (row.result?.vpcs ?? []).reduce((sum, v) => sum + (v.inboundOpenSecurityGroupCount || 0), 0);
  }

  protected resourceCount(row: NetworkMap): number {
    return (row.result?.vpcs ?? []).reduce((sum, v) => sum + (v.resourceCount || 0), 0);
  }

  protected add(): void {
    this.router.navigate(['add'], { relativeTo: this.route });
  }

  protected view(r: NetworkMap): void {
    this.router.navigate(['view', r.id], { relativeTo: this.route });
  }

  protected edit(r: NetworkMap): void {
    this.router.navigate(['edit', r.id], { relativeTo: this.route });
  }

  protected deleteRow(r: NetworkMap): void {
    this.confirmation.openGeneric('Delete', 'Network Map', r.name,
      () => this.svc.delete(r.id).toPromise(),
    ).then(() => this.refresh(true)).catch(() => { /* cancelled or already surfaced */ });
  }
}
