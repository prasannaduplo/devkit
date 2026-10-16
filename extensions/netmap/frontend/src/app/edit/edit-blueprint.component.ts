import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
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
    .panel-form-accordion { background: #fff; padding: 1.25rem 0 1rem 1.5rem; }
    .panel-content-title { width: 265px; min-width: 265px; }
    .panel-content-form { max-width: 900px; flex: 1 1 auto; margin: 0 1rem; padding: 0 1rem; }
    .nm-pick { border: 1px solid #ebe9f1; border-radius: .5rem; padding: .75rem; margin: .75rem 0; }
    .nm-pick h5 { font-size: .95rem; font-weight: 700; margin: 0 0 .5rem; }
    .nm-row { display: flex; gap: .75rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: .5rem; }
    .nm-row > div { min-width: 200px; }
    .nm-vpcs { width: 100%; font-size: .85rem; border-collapse: collapse; }
    .nm-vpcs th { color: #6e6b7b; font-weight: 600; padding: .35rem .5rem; border-bottom: 1px solid #ebe9f1; text-align: left; }
    .nm-vpcs td { padding: .35rem .5rem; border-bottom: 1px solid #f3f2f7; }
    .nm-vpcs tr.added td { color: #a3a1ad; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
    .nm-group { margin-bottom: .5rem; }
    .nm-group-h { font-weight: 700; color: #0d8f9e; font-size: .85rem; }
    .nm-member { display: flex; gap: .5rem; align-items: center; font-size: .85rem; padding: .15rem 0 .15rem 1rem; }
    .nm-warn { background: #fbf1de; color: #9a5b0c; border-radius: .25rem; padding: 0 .4rem; font-size: .75rem; }
    .nm-x { color: #b42318; cursor: pointer; }
  `],
  template: `
    <div class="card panel-form-accordion">
      <div class="d-flex justify-content-between">
        <div class="panel-content-title">
          <h4 class="font-weight-bolder">{{ isEdit ? 'Edit' : 'Create' }} Network Blueprint</h4>
          <p class="text-muted">A purpose plus a hand-picked set of VPCs, from any mix of scopes and regions. Scans are
            read-only — nothing is created or changed in AWS.</p>
        </div>

        <div class="panel-content-form">
          @if (loading()) {
            <div class="text-muted p-1">Loading…</div>
          } @else {
            <form name="EditBlueprintForm" #f="ngForm" class="form form-vertical" (ngSubmit)="submit()">
              <div class="nm-row">
                <div class="flex-grow-1">
                  <label class="element-label">Name *</label>
                  <input type="text" class="form-control" name="name" [ngModel]="name()" (ngModelChange)="name.set($event)"
                         [readonly]="isEdit" placeholder="e.g. payments-prod" required minlength="2" maxlength="60"
                         pattern="^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$" />
                </div>
                <div class="flex-grow-1">
                  <label class="element-label">Labels</label>
                  <input type="text" class="form-control" name="labels" [ngModel]="labelsText()" (ngModelChange)="labelsText.set($event)"
                         placeholder="env=prod, app=payments" />
                </div>
              </div>
              <div class="mb-1">
                <label class="element-label">Purpose</label>
                <input type="text" class="form-control" name="purpose" [ngModel]="purpose()" (ngModelChange)="purpose.set($event)"
                       placeholder="e.g. card-processing path: apps → internal load balancer → egress hub → partner APIs" />
              </div>

              <div class="nm-pick">
                <h5>① Add networks from a scope</h5>
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
                      @for (r of regions(); track r) { <option [value]="r">{{ r }}</option> }
                    </select>
                  </div>
                  <div class="flex-grow-1">
                    <label class="element-label">Filter</label>
                    <input type="text" class="form-control" name="vpcFilter" [ngModel]="vpcFilter()" (ngModelChange)="vpcFilter.set($event)"
                           placeholder="name, id, CIDR or tag" />
                  </div>
                </div>
                @if (vpcsLoading()) {
                  <div class="text-muted">Loading VPCs…</div>
                } @else if (scopeId() && region()) {
                  <table class="nm-vpcs">
                    <thead><tr><th></th><th>Name</th><th>VPC</th><th>CIDR(s)</th><th>Subnets</th><th>Tags</th></tr></thead>
                    <tbody>
                      @for (v of filteredVpcs(); track v.vpcId) {
                        <tr [class.added]="isAdded(v)">
                          <td><input type="checkbox" [checked]="checked().has(v.vpcId) || isAdded(v)" [disabled]="isAdded(v)" (change)="toggle(v.vpcId)" /></td>
                          <td>{{ v.name }}</td>
                          <td class="mono">{{ v.vpcId }}</td>
                          <td class="mono">{{ v.cidrs.join(', ') }}</td>
                          <td>{{ v.subnetCount }}</td>
                          <td class="mono">{{ tagText(v) }}</td>
                        </tr>
                      } @empty {
                        <tr><td colspan="6" class="text-muted">No VPCs in this region.</td></tr>
                      }
                    </tbody>
                  </table>
                  <div class="text-right mt-50">
                    <button type="button" class="btn btn-outline-primary btn-sm" [disabled]="!checked().size" (click)="addChecked()">
                      Add {{ checked().size || '' }} to blueprint
                    </button>
                  </div>
                }
              </div>

              <div class="nm-pick">
                <h5>② In this blueprint: {{ members().length }} network{{ members().length === 1 ? '' : 's' }} · {{ groups().length }} scope{{ groups().length === 1 ? '' : 's' }}</h5>
                @for (g of groups(); track g.scopeId) {
                  <div class="nm-group">
                    <div class="nm-group-h">{{ g.scopeName }}</div>
                    @for (r of g.regions; track r.region) {
                      @for (m of r.members; track m.networkId) {
                        <div class="nm-member">
                          <span class="mono">{{ r.region }}</span> · <span>{{ m.displayName }}</span> · <span class="mono">{{ m.networkId }}</span> · <span class="mono">{{ m.cidrs.join(', ') }}</span>
                          @if (warnings().get(key(m)); as w) { <span class="nm-warn">⚠ {{ w }}</span> }
                          <span class="nm-x" title="Remove" (click)="remove(m)">✕</span>
                        </div>
                      }
                    }
                  </div>
                } @empty {
                  <p class="text-muted mb-0">Pick a scope and region above, tick VPCs and add them.</p>
                }
              </div>

              @if (error()) { <div class="alert alert-danger p-1">{{ error() }}</div> }

              <div class="d-flex justify-content-end mt-1">
                <button type="button" class="btn btn-outline-secondary mr-1" (click)="cancel()">Cancel</button>
                <button type="submit" class="btn btn-primary" [disabled]="saving() || !members().length || (!isEdit && !name())">
                  {{ isEdit ? 'Save' : 'Create & scan' }}
                </button>
              </div>
            </form>
          }
        </div>
      </div>
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
  protected readonly vpcs = signal<PickerVpc[]>([]);
  protected readonly vpcsLoading = signal(false);
  protected readonly vpcFilter = signal('');
  protected readonly checked = signal<Set<string>>(new Set());
  protected readonly members = signal<SelectedMember[]>([]);

  protected readonly groups = computed(() => groupMembers(this.members()));
  protected readonly warnings = computed(() => overlapWarnings(this.members()));
  private readonly addedKeys = computed(() => new Set(this.members().map(memberKey)));
  protected readonly filteredVpcs = computed(() => {
    const q = this.vpcFilter().trim().toLowerCase();
    if (!q) return this.vpcs();
    return this.vpcs().filter(v => [v.name, v.vpcId, ...v.cidrs, ...Object.entries(v.tags).map(([k, val]) => `${k}=${val}`)]
      .some(s => s.toLowerCase().includes(q)));
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
    this.svc.regions(id).subscribe({
      next: regions => {
        this.regions.set(regions ?? []);
        const pick = regions?.includes('us-east-1') ? 'us-east-1' : regions?.[0] ?? '';
        this.onRegion(pick);
      },
      error: err => this.error.set(NetworkBlueprintService.errorMessage(err)),
    });
  }

  protected onRegion(region: string): void {
    this.region.set(region);
    this.checked.set(new Set());
    if (!region || !this.scopeId()) return;
    this.vpcsLoading.set(true);
    this.svc.vpcs(this.scopeId(), region).subscribe({
      next: vpcs => {
        this.vpcs.set(vpcs ?? []);
        this.vpcsLoading.set(false);
      },
      error: err => {
        this.vpcs.set([]);
        this.vpcsLoading.set(false);
        this.error.set(NetworkBlueprintService.errorMessage(err));
      },
    });
  }

  protected isAdded(v: PickerVpc): boolean {
    return this.addedKeys().has(memberKey({ provider: 'aws', region: this.region(), networkId: v.vpcId }));
  }

  protected toggle(vpcId: string): void {
    const next = new Set(this.checked());
    if (next.has(vpcId)) next.delete(vpcId);
    else next.add(vpcId);
    this.checked.set(next);
  }

  protected addChecked(): void {
    const scope = this.scopes().find(s => s.id === this.scopeId());
    if (!scope) return;
    const picked = this.vpcs().filter(v => this.checked().has(v.vpcId));
    this.members.set(addVpcs(this.members(), scope, this.region(), picked));
    this.checked.set(new Set());
  }

  protected remove(m: SelectedMember): void {
    this.members.set(removeMember(this.members(), memberKey(m)));
  }

  protected key(m: SelectedMember): string {
    return memberKey(m);
  }

  protected tagText(v: PickerVpc): string {
    return Object.entries(v.tags).filter(([k]) => k !== 'Name').map(([k, val]) => `${k}=${val}`).slice(0, 3).join(' · ');
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
