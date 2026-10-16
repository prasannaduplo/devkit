import { Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FilterTableUtils, SearchableDatatableComponent, SearchableDatatableModule } from '@duplocloud-internal/ng-common-lib';
import { NetworkBlueprint } from '../model/api-types';
import { LegacyNetworkMap, NetworkBlueprintService, REMOTE_UserSession } from '../network-blueprint.service';
import { StatusBadgeComponent } from '../shared/status-badge.component';

@Component({
  selector: 'nm-list',
  imports: [SearchableDatatableModule, StatusBadgeComponent, DatePipe],
  styles: [`
    .nm-legacy { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; }
    .nm-legacy-item { font-family: ui-monospace, monospace; font-size: .85rem; }
    .nm-chip { display: inline-block; font-size: .72rem; background: #eef1f4; color: #4a5560; border-radius: 1rem; padding: .05rem .5rem; margin: 0 .25rem .15rem 0; }
    .nm-scan { font-size: .8rem; color: #6e6b7b; }
  `],
  template: `
    @if (legacy().length) {
      <div class="alert alert-warning p-1 nm-legacy">
        <strong>Network Map now works with Network Blueprints.</strong>
        <span>These older single-region maps can no longer be opened — create a blueprint instead:</span>
        @for (m of legacy(); track m.id) {
          <span class="nm-legacy-item">{{ m.name }} <a class="text-danger cursor-pointer" (click)="removeLegacy(m)">delete</a></span>
        }
      </div>
    }
    <div class="card datatable-card">
      <searchable-datatable [showAdd]="true" addLabel="Create" (add)="add()" [rows]="rows()" (filter)="filterUpdate()" columnMode="force">

        <ngx-datatable-column [width]="50" [sortable]="false" [canAutoResize]="false" cellClass="actions">
          <ng-template ngx-datatable-cell-template let-row="row">
            <div ngbDropdown container="body">
              <button class="btn btn-sm hide-arrow" ngbDropdownToggle><i data-feather="more-vertical"></i></button>
              <div ngbDropdownMenu>
                <a ngbDropdownItem (click)="view(row)"><i data-feather="eye" class="mr-50"></i><span>View</span></a>
                <a ngbDropdownItem (click)="edit(row)"><i data-feather="edit" class="mr-50"></i><span>Edit</span></a>
                <a ngbDropdownItem (click)="scanNow(row)"><i data-feather="refresh-cw" class="mr-50"></i><span>Scan now</span></a>
                <div class="dropdown-divider"></div>
                <a ngbDropdownItem class="text-danger" (click)="remove(row)"><i data-feather="trash-2" class="mr-50"></i><span>Delete</span></a>
              </div>
            </div>
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Name" [flexGrow]="130">
          <ng-template ngx-datatable-cell-template let-row="row">
            <a (click)="view(row)" class="text-primary font-weight-medium cursor-pointer">{{ row.name }}</a>
            @if (row.spec?.purpose) { <div class="text-muted small">{{ row.spec.purpose }}</div> }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Labels" [flexGrow]="110" [sortable]="false">
          <ng-template ngx-datatable-cell-template let-row="row">
            @for (l of labels(row); track l) { <span class="nm-chip">{{ l }}</span> }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Networks" [flexGrow]="60">
          <ng-template ngx-datatable-cell-template let-row="row">{{ row.spec?.members?.length ?? 0 }}</ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Last scan" [flexGrow]="120">
          <ng-template ngx-datatable-cell-template let-row="row">
            @if (row.result?.activeScan) {
              <span class="nm-scan">scanning {{ row.result.activeScan.unitsFinished }}/{{ row.result.activeScan.unitsTotal }}</span>
            } @else if (row.result?.latestSummary; as s) {
              <span class="nm-scan">{{ s.status }} · {{ s.finishedAt | date:'short' }}</span>
            } @else { — }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Findings" [flexGrow]="70" [sortable]="false">
          <ng-template ngx-datatable-cell-template let-row="row">
            @if (row.result?.latestSummary; as s) {
              @if (s.findingsBad) { <span class="badge badge-light-danger mr-50">{{ s.findingsBad }} critical</span> }
              @if (s.findingsWarn) { <span class="badge badge-light-warning">{{ s.findingsWarn }} warn</span> }
              @if (!s.findingsBad && !s.findingsWarn) { <span class="text-muted">none</span> }
            } @else { — }
          </ng-template>
        </ngx-datatable-column>

        <ngx-datatable-column name="Status" [flexGrow]="90" [maxWidth]="140">
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
export class ListBlueprintsComponent implements OnInit {
  private readonly svc = inject(NetworkBlueprintService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject<any>(REMOTE_UserSession as any);
  private readonly destroyRef = inject(DestroyRef);
  private readonly table = viewChild(SearchableDatatableComponent);

  private readonly allRows = signal<NetworkBlueprint[]>([]);
  private readonly filterTerm = signal('');
  private readonly searchFields = ['name', 'status', 'spec.purpose'];
  protected readonly legacy = signal<LegacyNetworkMap[]>([]);

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
    if (tenantChanged) this.table()?.startLoading();
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
    this.svc.legacyList().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: rows => this.legacy.set(rows ?? []),
      error: () => this.legacy.set([]),
    });
  }

  protected labels(row: NetworkBlueprint): string[] {
    return Object.entries(row.spec?.labels ?? {}).map(([k, v]) => `${k}=${v}`);
  }

  protected filterUpdate(): void {
    this.filterTerm.set(this.table()?.searchTerm?.toLowerCase()?.trim() ?? '');
  }

  protected add(): void {
    this.router.navigate(['add'], { relativeTo: this.route });
  }

  protected view(r: NetworkBlueprint): void {
    this.router.navigate(['view', r.id], { relativeTo: this.route });
  }

  protected edit(r: NetworkBlueprint): void {
    this.router.navigate(['edit', r.id], { relativeTo: this.route });
  }

  protected scanNow(r: NetworkBlueprint): void {
    this.svc.scanNow(r).subscribe({ next: () => this.refresh(false), error: err => alert(NetworkBlueprintService.errorMessage(err)) });
  }

  protected remove(r: NetworkBlueprint): void {
    if (!confirm(`Delete blueprint "${r.name}" and its snapshots? Nothing in AWS is changed.`)) return;
    this.svc.delete(r.id).subscribe({ next: () => this.refresh(false), error: err => alert(NetworkBlueprintService.errorMessage(err)) });
  }

  protected removeLegacy(m: LegacyNetworkMap): void {
    if (!confirm(`Delete the old network map "${m.name}"? Nothing in AWS is changed.`)) return;
    this.svc.legacyDelete(m.id).subscribe({ next: () => this.refresh(false), error: err => alert(NetworkBlueprintService.errorMessage(err)) });
  }
}
