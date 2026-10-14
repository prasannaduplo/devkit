import { Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FilterTableUtils, SearchableDatatableComponent, SearchableDatatableModule } from '@duplocloud-internal/ng-common-lib';
import { CloudflareWatch, CloudflareWatchService, REMOTE_UserSession } from '../cloudflare-watch.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';

// List of Cloudflare watches on the platform's <searchable-datatable>. Worker resource: no Track action.
@Component({
  selector: 'cfw-list',
  imports: [SearchableDatatableModule, StatusBadgeComponent, DatePipe],
  template: `
    <div class="card datatable-card">
      <searchable-datatable
        [showAdd]="true"
        addLabel="Create"
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
                <a ngbDropdownItem (click)="view(row)"><i data-feather="eye" class="mr-50"></i><span>View</span></a>
                <a ngbDropdownItem (click)="edit(row)"><i data-feather="edit" class="mr-50"></i><span>Edit</span></a>
              </div>
            </div>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Name" [flexGrow]="150">
          <ng-template ngx-datatable-cell-template let-row="row">
            <a (click)="view(row)" class="text-primary font-weight-medium cursor-pointer">{{ row.name }}</a>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Workers" [flexGrow]="70">
          <ng-template ngx-datatable-cell-template let-row="row">{{ row.result?.scriptCount ?? '—' }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Last deploy" [flexGrow]="180">
          <ng-template ngx-datatable-cell-template let-row="row">
            @if (lastDeploy(row); as d) {
              <span class="mono">{{ d.script }}</span> · {{ d.at | date:'short' }}
            } @else { — }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Last scanned" [flexGrow]="110">
          <ng-template ngx-datatable-cell-template let-row="row">
            {{ row.result?.lastScannedAt ? (row.result.lastScannedAt | date:'short') : '—' }}
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Status" [flexGrow]="110" [maxWidth]="150">
          <ng-template ngx-datatable-cell-template let-row="row">
            <app-status-badge [status]="row.status"></app-status-badge>
            @if (row.result?.lastError) {
              <i data-feather="alert-triangle" class="text-warning ml-50" [title]="row.result.lastError"></i>
            }
          </ng-template>
        </ngx-datatable-column>

      </searchable-datatable>
    </div>
  `,
})
export class ListCloudflareWatchComponent implements OnInit {
  private readonly svc = inject(CloudflareWatchService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject<any>(REMOTE_UserSession as any);
  private readonly destroyRef = inject(DestroyRef);

  private readonly table = viewChild(SearchableDatatableComponent);
  private readonly allRows = signal<CloudflareWatch[]>([]);
  private readonly filterTerm = signal('');
  private readonly searchFields = ['name', 'status', 'result.accountId'];

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
      },
    });
  }

  /** Most recent deploy across the account — from the per-script state, so it shows even before any change event. */
  protected lastDeploy(row: CloudflareWatch): { script: string; at: string } | null {
    const latest = (row.result?.scripts ?? [])
      .filter(s => !!s.lastDeployedAt)
      .sort((a, b) => (b.lastDeployedAt ?? '').localeCompare(a.lastDeployedAt ?? ''))[0];
    return latest ? { script: latest.name, at: latest.lastDeployedAt! } : null;
  }

  protected filterUpdate(): void {
    this.filterTerm.set(this.table()?.searchTerm?.toLowerCase()?.trim() ?? '');
  }

  protected add(): void {
    this.router.navigate(['add'], { relativeTo: this.route });
  }

  protected view(r: CloudflareWatch): void {
    this.router.navigate(['view', r.id], { relativeTo: this.route });
  }

  protected edit(r: CloudflareWatch): void {
    this.router.navigate(['edit', r.id], { relativeTo: this.route });
  }
}
