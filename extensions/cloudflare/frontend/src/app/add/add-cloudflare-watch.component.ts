import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormGroupErrorsComponent, SharedFormsModule } from '@duplocloud-internal/ng-common-lib';
import { CloudflareWatchService, WorkspaceScope } from '../cloudflare-watch.service';

// Template-driven form; each field is a signal bound one-way with an explicit (ngModelChange) writer.
@Component({
  selector: 'cfw-add',
  imports: [SharedFormsModule],
  styles: [`
    :host { display: block; }
    .panel-form-accordion { background: #fff; padding: 1.25rem 0 1rem 1.5rem; }
    .panel-content-title { width: 265px; min-width: 265px; }
    .panel-content-title-sub-text { max-width: 220px; }
    .panel-content-form { max-width: 768px; flex: 1 1 auto; margin: 0 1rem; padding: 0 1rem; }
    .panel-content-sidenav { width: 265px; min-width: 265px; margin-left: 2rem; }
    .panel-content-sidenav .help-item { padding-bottom: 1rem; }
    .panel-content-sidenav .help-item-title { margin: 0; font-weight: 600; font-size: 0.9rem; }
  `],
  template: `
    <div class="card panel-form-accordion">
      <div class="d-flex justify-content-between">

        <div class="panel-content-title">
          <h4 class="font-weight-bolder">{{ isEdit ? 'Edit' : 'Create' }} Workers Watch</h4>
          <p class="panel-content-title-sub-text text-muted">
            Watch a Cloudflare account's Workers: inventory, deployments and who deployed them. Read-only.
          </p>
        </div>

        <div class="panel-content-form">
          @if (loading()) {
            <div class="text-muted p-1">Loading…</div>
          } @else {
            <form name="AddCloudflareWatchForm" #f="ngForm" class="form form-vertical" (ngSubmit)="f.valid && submit()">
              <div class="form-container" form-group-errors #formGroupErrors showDetailsWhen="submitted">
                <form-field>
                  <label class="element-label">Name *</label>
                  <input type="text" class="form-control" name="name"
                         [ngModel]="name()" (ngModelChange)="name.set($event)" [readonly]="isEdit"
                         placeholder="e.g. mtr-workers" required validation-state validation-errors
                         minlength="2" maxlength="60" pattern="^[a-zA-Z0-9]([a-zA-Z0-9\\-]*[a-zA-Z0-9])?$" />
                </form-field>
                <form-field>
                  <label class="element-label">Cloudflare scope *</label>
                  <select class="form-control" name="scopeId"
                          [ngModel]="scopeId()" (ngModelChange)="scopeId.set($event)"
                          required validation-state validation-errors>
                    <option value="" disabled>Select a scope…</option>
                    @for (s of scopes(); track s.id) {
                      <option [value]="s.id">{{ s.name }}</option>
                    }
                  </select>
                </form-field>
                <form-field>
                  <label class="element-label">Script name filter</label>
                  <input type="text" class="form-control" name="scriptNameFilter"
                         [ngModel]="scriptNameFilter()" (ngModelChange)="scriptNameFilter.set($event)"
                         placeholder="e.g. api-*, agent-*  (empty = all Workers)" maxlength="200" />
                </form-field>
                <form-field>
                  <label class="element-label">History limit</label>
                  <input type="number" class="form-control" name="historyLimit"
                         [ngModel]="historyLimit()" (ngModelChange)="historyLimit.set($event)"
                         min="1" max="1000" step="1" validation-state validation-errors />
                </form-field>

                <div class="d-flex justify-content-end mt-1">
                  <button type="button" class="btn btn-outline-secondary mr-1" (click)="cancel()">Cancel</button>
                  <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ isEdit ? 'Save' : 'Create' }}</button>
                </div>
              </div>
            </form>
          }
        </div>

        <div class="panel-content-sidenav">
          <div class="help-item">
            <p class="help-item-title">Cloudflare scope</p>
            <small class="text-muted">A provider of type <b>Other</b> whose credential has <code>accountId</code> and an
              account-owned <code>apiToken</code> with <i>Workers Scripts: Read</i>.</small>
          </div>
          <div class="help-item">
            <p class="help-item-title">Script name filter</p>
            <small class="text-muted">Comma-separated globs (<code>*</code>, <code>?</code>). Changing it re-baselines the watch.</small>
          </div>
          <div class="help-item">
            <p class="help-item-title">Polling</p>
            <small class="text-muted">The worker rescans every 5 minutes. Workers that exist at creation form the baseline;
              only later adds, deletes and deployments are recorded as changes.</small>
          </div>
        </div>

      </div>
    </div>
  `,
})
export class AddCloudflareWatchComponent implements OnInit {
  private readonly svc = inject(CloudflareWatchService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly name = signal('');
  protected readonly scopeId = signal('');
  protected readonly scriptNameFilter = signal('');
  protected readonly historyLimit = signal(200);
  protected readonly scopes = signal<WorkspaceScope[]>([]);
  protected readonly saving = signal(false);
  protected readonly loading = signal(false);

  protected readonly isEdit = this.route.snapshot.data['action'] === 'Edit';
  private readonly id: string = this.route.snapshot.params['id'];
  private loadedSpec: Record<string, any> = {};

  private readonly formErrors = viewChild(FormGroupErrorsComponent);

  ngOnInit(): void {
    this.svc.scopes().subscribe({
      next: list => {
        // Cloudflare-looking scopes first; the backend still enforces the Other category.
        const sorted = [...(list ?? [])].sort((a, b) =>
          Number(/cloudflare|\bcf\b/i.test(b.name)) - Number(/cloudflare|\bcf\b/i.test(a.name)) || a.name.localeCompare(b.name));
        this.scopes.set(sorted);
        if (!this.isEdit && !this.scopeId() && sorted.length && /cloudflare/i.test(sorted[0].name)) {
          this.scopeId.set(sorted[0].id);
        }
      },
      error: err => this.formErrors()?.reportError(err),
    });

    if (!this.isEdit) {
      return;
    }
    this.loading.set(true);
    this.svc.get(this.id).subscribe({
      next: item => {
        this.loadedSpec = item?.spec ?? {};
        this.name.set(item?.name ?? '');
        this.scopeId.set(item?.spec?.scopeIds?.[0] ?? '');
        this.scriptNameFilter.set(item?.spec?.scriptNameFilter ?? '');
        this.historyLimit.set(item?.spec?.historyLimit ?? 200);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  protected submit(): void {
    this.saving.set(true);
    const spec = {
      ...this.loadedSpec,
      scopeIds: [this.scopeId()],
      scriptNameFilter: this.scriptNameFilter()?.trim() || null,
      historyLimit: Number(this.historyLimit()) || 200,
    };
    const call = this.isEdit ? this.svc.update(this.id, spec) : this.svc.create(this.name(), spec);
    call.subscribe({
      next: () => this.back(),
      error: err => {
        this.saving.set(false);
        this.formErrors()?.reportError(err);
      },
    });
  }

  protected cancel(): void {
    this.back();
  }

  private back(): void {
    this.router.navigate([this.isEdit ? '../..' : '..'], { relativeTo: this.route });
  }
}
