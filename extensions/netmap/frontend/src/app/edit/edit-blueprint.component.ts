import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, from, of } from 'rxjs';
import { catchError, map, mergeMap, toArray } from 'rxjs/operators';
import { SharedFormsModule } from '@duplocloud-internal/ng-common-lib';
import { NetworkBlueprint, PickerVpc, WorkspaceScope } from '../model/api-types';
import {
  SelectedMember, addVpcs, formatLabels, fromSpec, groupMembers, memberKey, overlapWarnings, parseLabels, removeMember, toSpecMembers,
} from '../model/picker';
import { NetworkBlueprintService } from '../network-blueprint.service';

@Component({
  selector: 'nm-edit',
  imports: [SharedFormsModule],
  styles: [`
    :host { display: block; }
    .nm-edit { background: #fff; padding: 1rem 1.25rem; height: calc(100vh - 150px); min-height: 520px; display: flex; flex-direction: column; overflow: hidden; }
    .nm-edit form { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
    .nm-head { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: .5rem; }
    .nm-head h4 { margin: 0; font-weight: 700; }
    .nm-head p { margin: 0; color: #8a8797; font-size: .85rem; }
    .nm-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 2fr); gap: .75rem; margin-bottom: .75rem; }
    .nm-fields > div, .nm-row > div { min-width: 0; }
    .nm-fields .form-control, .nm-row .form-control { width: 100%; }
    .nm-panes { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: .75rem; flex: 1 1 auto; min-height: 0; }
    .nm-pick { border: 1px solid #ebe9f1; border-radius: .5rem; padding: .75rem; display: flex; flex-direction: column; min-height: 0; }
    .nm-pick h5 { font-size: .95rem; font-weight: 700; margin: 0 0 .25rem; }
    .nm-pick .hint { font-size: .78rem; color: #8a8797; margin: 0 0 .5rem; }
    .nm-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr); gap: .5rem; margin-bottom: .5rem; }
    .nm-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; border-top: 1px solid #ebe9f1; }
    .nm-vpcs { width: 100%; font-size: .82rem; border-collapse: collapse; table-layout: fixed; }
    .nm-vpcs th { position: sticky; top: 0; background: #fafafc; z-index: 1; color: #6e6b7b; font-weight: 600; padding: .35rem .5rem; border-bottom: 1px solid #ebe9f1; text-align: left; }
    .nm-vpcs td { padding: .3rem .5rem; border-bottom: 1px solid #f3f2f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nm-vpcs tr { cursor: pointer; }
    .nm-vpcs tr:hover td { background: rgba(13, 143, 158, .05); }
    .nm-vpcs tr.added td { color: #a3a1ad; cursor: default; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
    .nm-pick-foot { display: flex; justify-content: space-between; align-items: center; padding-top: .5rem; font-size: .8rem; color: #8a8797; }
    .nm-group { margin-bottom: .5rem; }
    .nm-group-h { font-weight: 700; color: #0d8f9e; font-size: .85rem; }
    .nm-member { display: flex; gap: .4rem; align-items: center; font-size: .82rem; padding: .15rem 0 .15rem .75rem; white-space: nowrap; overflow: hidden; }
    .nm-member .grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .nm-warn { background: #fbf1de; color: #9a5b0c; border-radius: .25rem; padding: 0 .4rem; font-size: .72rem; }
    .nm-x { color: #b42318; cursor: pointer; }
    .nm-foot { display: flex; justify-content: flex-end; align-items: center; gap: .75rem; padding-top: .75rem; }
    .nm-foot .alert { margin: 0 auto 0 0; padding: .4rem .75rem; font-size: .82rem; }
    @media (max-width: 1000px) { .nm-panes, .nm-fields { grid-template-columns: minmax(0, 1fr); } .nm-edit { height: auto; overflow: visible; } }
  `],
  template: `
    <div class="card nm-edit">
      <div class="nm-head">
        <h4>{{ isEdit ? 'Edit' : 'Create' }} Network Blueprint</h4>
        <p>Hand-pick VPCs from any mix of scopes and regions. Scans are read-only — nothing changes in AWS.</p>
      </div>
      @if (loading()) {
        <div class="text-muted p-1">Loading…</div>
      } @else {
        <form name="EditBlueprintForm" #f="ngForm" class="form form-vertical" (ngSubmit)="submit()">
          <div class="nm-fields">
            <div>
              <label class="element-label">Name *</label>
              <input type="text" class="form-control" name="name" [ngModel]="name()" (ngModelChange)="name.set($event)"
                     [readonly]="isEdit" placeholder="e.g. payments-prod" required minlength="2" maxlength="60"
                     pattern="^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$" />
            </div>
            <div>
              <label class="element-label">Labels</label>
              <input type="text" class="form-control" name="labels" [ngModel]="labelsText()" (ngModelChange)="labelsText.set($event)"
                     placeholder="env=prod, app=payments" />
            </div>
            <div>
              <label class="element-label">Purpose</label>
              <input type="text" class="form-control" name="purpose" [ngModel]="purpose()" (ngModelChange)="purpose.set($event)"
                     placeholder="e.g. apps → internal load balancer → egress hub → partner APIs" />
            </div>
          </div>

          <div class="nm-panes">
            <div class="nm-pick">
              <h5>① Add networks</h5>
              <p class="hint">Picks are kept as you switch — add from as many scopes and regions as you like, or search all regions at once.</p>
              <div class="nm-row">
                <div>
                  <label class="element-label">Scope</label>
                  <select class="form-control" name="scopeId" [ngModel]="scopeId()" (ngModelChange)="onScope($event)">
                    <option value="" disabled>Select a scope…</option>
                    @for (s of scopes(); track s.id) { <option [value]="s.id">{{ s.name }}</option> }
                  </select>
                </div>
                <div>
                  <label class="element-label">Region</label>
                  <select class="form-control" name="region" [ngModel]="region()" (ngModelChange)="onRegion($event)" [disabled]="!regions().length">
                    <option [value]="ALL">All regions</option>
                    @for (r of regions(); track r) { <option [value]="r">{{ r }}</option> }
                  </select>
                </div>
                <div>
                  <label class="element-label">Search</label>
                  <input type="search" class="form-control" name="vpcFilter" [ngModel]="vpcFilter()" (ngModelChange)="vpcFilter.set($event)"
                         placeholder="name, id, CIDR, tag, region" />
                </div>
              </div>
              <div class="nm-scroll">
                @if (vpcsLoading()) {
                  <div class="text-muted p-50">Loading VPCs{{ region() === ALL ? ' from ' + regionsDone() + '/' + regions().length + ' regions' : '' }}…</div>
                } @else if (!scopeId()) {
                  <div class="text-muted p-50">Select a scope to list its VPCs.</div>
                } @else {
                  <table class="nm-vpcs">
                    <colgroup><col style="width:32px"><col style="width:22%"><col style="width:22%"><col style="width:16%"><col style="width:12%"><col style="width:60px"><col></colgroup>
                    <thead><tr>
                      <th><input type="checkbox" title="Select all shown" [checked]="allShownChecked()" (change)="toggleAllShown()" /></th>
                      <th>Name</th><th>VPC</th><th>CIDR(s)</th><th>Region</th><th>Subnets</th><th>Tags</th>
                    </tr></thead>
                    <tbody>
                      @for (v of filteredVpcs(); track v.key) {
                        <tr [class.added]="v.added" (click)="toggle(v)">
                          <td><input type="checkbox" [checked]="checked().has(v.key) || v.added" [disabled]="v.added" (click)="$event.stopPropagation()" (change)="toggle(v)" /></td>
                          <td [title]="v.name">{{ v.name }}</td>
                          <td class="mono" [title]="v.vpcId">{{ v.vpcId }}</td>
                          <td class="mono" [title]="v.cidrs.join(', ')">{{ v.cidrs.join(', ') }}</td>
                          <td class="mono">{{ v.region }}</td>
                          <td>{{ v.subnetCount }}</td>
                          <td class="mono" [title]="v.tagsFull">{{ v.tagsShort }}</td>
                        </tr>
                      } @empty {
                        <tr><td colspan="7" class="text-muted">{{ vpcFilter() ? 'No VPCs match the search.' : 'No VPCs here.' }}</td></tr>
                      }
                    </tbody>
                  </table>
                }
              </div>
              <div class="nm-pick-foot">
                <span>{{ filteredVpcs().length }} of {{ vpcs().length }} shown</span>
                <button type="button" class="btn btn-outline-primary btn-sm" [disabled]="!checked().size" (click)="addChecked()">
                  Add {{ checked().size || '' }} to blueprint →
                </button>
              </div>
            </div>

            <div class="nm-pick">
              <h5>② In this blueprint</h5>
              <p class="hint">{{ members().length }} network{{ members().length === 1 ? '' : 's' }} · {{ groups().length }} scope{{ groups().length === 1 ? '' : 's' }} · {{ regionCount() }} region{{ regionCount() === 1 ? '' : 's' }}</p>
              <div class="nm-scroll pt-50">
                @for (g of groups(); track g.scopeId) {
                  <div class="nm-group">
                    <div class="nm-group-h">{{ g.scopeName }}</div>
                    @for (r of g.regions; track r.region) {
                      @for (m of r.members; track m.networkId) {
                        <div class="nm-member">
                          <span class="mono">{{ r.region }}</span>
                          <span class="grow" [title]="m.networkId + ' · ' + m.cidrs.join(', ')">{{ m.displayName }} · <span class="mono">{{ m.cidrs.join(', ') }}</span></span>
                          @if (warnings().get(key(m)); as w) { <span class="nm-warn" [title]="w">⚠ overlap</span> }
                          <span class="nm-x" title="Remove" (click)="remove(m)">✕</span>
                        </div>
                      }
                    }
                  </div>
                } @empty {
                  <p class="text-muted mb-0">Nothing yet — tick VPCs on the left and add them.</p>
                }
              </div>
            </div>
          </div>

          <div class="nm-foot">
            @if (error()) { <div class="alert alert-danger">{{ error() }} @if (lastFailed) { <a class="cursor-pointer font-weight-bold ml-50" (click)="retry()">Retry</a> }</div> }
            <button type="button" class="btn btn-outline-secondary" (click)="cancel()">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="saving() || !members().length || (!isEdit && !name())">
              {{ isEdit ? 'Save' : 'Create & scan' }}
            </button>
          </div>
        </form>
      }
    </div>
  `,
})
export class EditBlueprintComponent implements OnInit {
  private readonly svc = inject(NetworkBlueprintService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly isEdit = this.route.snapshot.data['action'] === 'Edit';
  private readonly id: string = this.route.snapshot.params['id'];
  private existing: NetworkBlueprint | null = null;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly name = signal('');
  protected readonly purpose = signal('');
  protected readonly labelsText = signal('');
  protected readonly scopes = signal<WorkspaceScope[]>([]);
  protected readonly scopeId = signal('');
  protected readonly regions = signal<string[]>([]);
  protected readonly region = signal('');
  protected readonly ALL = '*';
  protected readonly vpcs = signal<RegionVpc[]>([]);
  protected readonly regionsDone = signal(0);
  protected lastFailed: (() => void) | null = null;
  protected readonly vpcsLoading = signal(false);
  protected readonly vpcFilter = signal('');
  protected readonly checked = signal<Set<string>>(new Set());
  protected readonly members = signal<SelectedMember[]>([]);

  protected readonly groups = computed(() => groupMembers(this.members()));
  protected readonly warnings = computed(() => overlapWarnings(this.members()));
  private readonly addedKeys = computed(() => new Set(this.members().map(memberKey)));
  protected readonly regionCount = computed(() => new Set(this.members().map(m => m.region)).size);
  protected readonly filteredVpcs = computed(() => {
    const q = this.vpcFilter().trim().toLowerCase();
    const added = this.addedKeys();
    const rows = this.vpcs().map(v => ({ ...v, added: added.has(memberKey({ provider: 'aws', region: v.region, networkId: v.vpcId })) }));
    if (!q) return rows;
    return rows.filter(v => [v.name, v.vpcId, v.region, ...v.cidrs, v.tagsFull].some(s => s.toLowerCase().includes(q)));
  });
  protected readonly allShownChecked = computed(() => {
    const open = this.filteredVpcs().filter(v => !v.added);
    return open.length > 0 && open.every(v => this.checked().has(v.key));
  });

  ngOnInit(): void {
    forkJoin([this.svc.scopes(), this.isEdit ? this.svc.get(this.id) : of(null)]).subscribe({
      next: ([scopes, item]) => {
        this.scopes.set(scopes ?? []);
        if (item) {
          this.existing = item;
          this.name.set(item.name);
          this.purpose.set(item.spec?.purpose ?? '');
          this.labelsText.set(formatLabels(item.spec?.labels));
          this.members.set(fromSpec(item.spec?.members ?? [], scopes ?? [], item.result?.memberStatuses ?? []));
        }
        this.loading.set(false);
      },
      error: err => {
        this.error.set(NetworkBlueprintService.errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected onScope(id: string): void {
    this.scopeId.set(id);
    this.regions.set([]);
    this.vpcs.set([]);
    this.error.set('');
    this.lastFailed = null;
    this.svc.regions(id).subscribe({
      next: regions => {
        this.regions.set(regions ?? []);
        const pick = regions?.includes('us-east-1') ? 'us-east-1' : regions?.[0] ?? '';
        this.onRegion(pick);
      },
      error: err => this.fail(err, () => this.onScope(id)),
    });
  }

  protected onRegion(region: string): void {
    this.region.set(region);
    this.checked.set(new Set());
    this.error.set('');
    this.lastFailed = null;
    const scopeId = this.scopeId();
    if (!region || !scopeId) return;
    this.vpcsLoading.set(true);
    if (region === this.ALL) {
      // one region failing (opt-in region, throttling) must not hide the rest
      this.regionsDone.set(0);
      from(this.regions()).pipe(
        mergeMap(r => this.svc.vpcs(scopeId, r).pipe(
          map(vpcs => (vpcs ?? []).map(v => toRow(v, r))),
          catchError(() => of([] as RegionVpc[])),
          map(rows => { this.regionsDone.update(n => n + 1); return rows; }),
        ), 4),
        toArray(),
      ).subscribe(all => {
        this.vpcs.set(all.flat().sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name)));
        this.vpcsLoading.set(false);
      });
      return;
    }
    this.svc.vpcs(scopeId, region).subscribe({
      next: vpcs => {
        this.vpcs.set((vpcs ?? []).map(v => toRow(v, region)));
        this.vpcsLoading.set(false);
      },
      error: err => {
        this.vpcs.set([]);
        this.vpcsLoading.set(false);
        this.fail(err, () => this.onRegion(region));
      },
    });
  }

  private fail(err: any, retry: () => void): void {
    this.error.set(NetworkBlueprintService.errorMessage(err));
    this.lastFailed = retry;
  }

  protected retry(): void {
    const r = this.lastFailed;
    this.lastFailed = null;
    r?.();
  }

  protected toggle(v: RegionVpc & { added: boolean }): void {
    if (v.added) return;
    const next = new Set(this.checked());
    if (next.has(v.key)) next.delete(v.key);
    else next.add(v.key);
    this.checked.set(next);
  }

  protected toggleAllShown(): void {
    const open = this.filteredVpcs().filter(v => !v.added);
    const next = new Set(this.checked());
    if (this.allShownChecked()) open.forEach(v => next.delete(v.key));
    else open.forEach(v => next.add(v.key));
    this.checked.set(next);
  }

  protected addChecked(): void {
    const scope = this.scopes().find(s => s.id === this.scopeId());
    if (!scope) return;
    const picked = this.vpcs().filter(v => this.checked().has(v.key));
    let members = this.members();
    for (const r of new Set(picked.map(v => v.region))) members = addVpcs(members, scope, r, picked.filter(v => v.region === r));
    this.members.set(members);
    this.checked.set(new Set());
  }

  protected remove(m: SelectedMember): void {
    this.members.set(removeMember(this.members(), memberKey(m)));
  }

  protected key(m: SelectedMember): string {
    return memberKey(m);
  }

  protected submit(): void {
    this.error.set('');
    let labels: Record<string, string>;
    try {
      labels = parseLabels(this.labelsText());
    } catch (e: any) {
      this.error.set(`Labels: ${e.message}`);
      return;
    }
    const spec = {
      ...(this.existing?.spec ?? {}),
      purpose: this.purpose().trim() || null,
      labels,
      members: toSpecMembers(this.members()),
    };
    this.saving.set(true);
    const call = this.isEdit ? this.svc.update(this.id, spec) : this.svc.create(this.name().trim(), spec);
    call.subscribe({
      next: saved => this.router.navigate(this.isEdit ? ['../../view', this.id] : ['../view', saved?.id], { relativeTo: this.route }),
      error: err => {
        this.saving.set(false);
        this.error.set(NetworkBlueprintService.errorMessage(err));
      },
    });
  }

  protected cancel(): void {
    this.router.navigate([this.isEdit ? '../..' : '..'], { relativeTo: this.route });
  }
}

interface RegionVpc extends PickerVpc {
  region: string;
  key: string;
  tagsShort: string;
  tagsFull: string;
}

// aws:* tags (CloudFormation stack ids etc.) are noise in a picker; keep them searchable but don't show them.
function toRow(v: PickerVpc, region: string): RegionVpc {
  const tags = Object.entries(v.tags ?? {}).filter(([k]) => k !== 'Name');
  const own = tags.filter(([k]) => !k.startsWith('aws:'));
  return {
    ...v,
    region,
    key: `${region}|${v.vpcId}`,
    tagsShort: own.map(([k, val]) => `${k}=${val}`).slice(0, 3).join(' · '),
    tagsFull: tags.map(([k, val]) => `${k}=${val}`).join('\n'),
  };
}
