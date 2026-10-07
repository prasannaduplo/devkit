import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormGroupErrorsComponent, SharedFormsModule } from '@duplocloud-internal/ng-common-lib';
import { RdsUpgradeService } from '../rds-upgrade.service';

// Add/Edit form in the platform's 3-column `panel-form-accordion` layout: title+description (left), inputs
// (center), per-field help (right). One component serves both routes — `edit/:id` carries data.action='Edit'.
//
// v1 is a plain text-field form — no live AWS instance picker (that's a v2 nicety; see EXTENSION_BACKLOG.md
// #36). The user types the exact instance identifier they already know.
@Component({
  selector: 'rds-add',
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
          <h4 class="font-weight-bolder">{{ isEdit ? 'Edit' : 'Create' }} RDS Upgrade</h4>
          <p class="panel-content-title-sub-text text-muted">
            Upgrades an RDS instance to a target engine version via an AWS Blue/Green Deployment
            (precheck, snapshot, create, validate, switchover, cleanup — runs automatically once created).
          </p>
        </div>

        <div class="panel-content-form">
          @if (loading()) {
            <div class="text-muted p-1">Loading…</div>
          } @else {
            <form name="AddRdsUpgradeForm" #f="ngForm" class="form form-vertical" (ngSubmit)="f.valid && submit()">
              <div class="form-container" form-group-errors #formGroupErrors showDetailsWhen="submitted">
                <form-field>
                  <label class="element-label">Name *</label>
                  <!-- The name identifies the resource, so it is fixed once provisioned. -->
                  <input type="text" class="form-control" name="name"
                         [ngModel]="name()" (ngModelChange)="name.set($event)" [readonly]="isEdit"
                         placeholder="e.g. payfinia-mysql-upgrade" required validation-state validation-errors
                         minlength="2" maxlength="60" pattern="^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$" />
                </form-field>
                <form-field>
                  <label class="element-label">Source RDS Instance Identifier *</label>
                  <input type="text" class="form-control" name="dbInstanceIdentifier"
                         [ngModel]="dbInstanceIdentifier()" (ngModelChange)="dbInstanceIdentifier.set($event)"
                         placeholder="e.g. ipx-prod-mysql" required validation-state validation-errors [readonly]="isEdit" />
                </form-field>
                <form-field>
                  <label class="element-label">AWS Region *</label>
                  <input type="text" class="form-control" name="region"
                         [ngModel]="region()" (ngModelChange)="region.set($event)"
                         placeholder="e.g. us-east-1" required validation-state validation-errors [readonly]="isEdit" />
                </form-field>
                <form-field>
                  <label class="element-label">Target Engine Version *</label>
                  <input type="text" class="form-control" name="targetEngineVersion"
                         [ngModel]="targetEngineVersion()" (ngModelChange)="targetEngineVersion.set($event)"
                         placeholder="e.g. 8.4.3" required validation-state validation-errors />
                </form-field>
                <form-field>
                  <label class="element-label">Target Instance Class</label>
                  <input type="text" class="form-control" name="targetInstanceClass"
                         [ngModel]="targetInstanceClass()" (ngModelChange)="targetInstanceClass.set($event)"
                         placeholder="Optional — defaults to the source's class" />
                </form-field>
                <form-field>
                  <label class="element-label">Target Parameter Group</label>
                  <input type="text" class="form-control" name="targetParameterGroupName"
                         [ngModel]="targetParameterGroupName()" (ngModelChange)="targetParameterGroupName.set($event)"
                         placeholder="Optional — defaults to a clone of the source's group" />
                </form-field>
                <form-field>
                  <label class="element-label">Switchover Timeout (minutes)</label>
                  <input type="number" class="form-control" name="switchoverTimeoutMinutes" min="1" max="60"
                         [ngModel]="switchoverTimeoutMinutes()" (ngModelChange)="switchoverTimeoutMinutes.set($event)" />
                </form-field>

                <div class="d-flex justify-content-end mt-1">
                  <button type="button" class="btn btn-outline-secondary mr-1" (click)="cancel()">Cancel</button>
                  <button type="submit" class="btn btn-primary" [disabled]="saving()">
                    {{ isEdit ? 'Save' : 'Provision' }}
                  </button>
                </div>
              </div>
            </form>
          }
        </div>

        <div class="panel-content-sidenav">
          <div class="help-item">
            <p class="help-item-title">Source Instance</p>
            <small class="text-muted">The RDS instance to upgrade. Must use MySQL, MariaDB, PostgreSQL, Aurora
              MySQL, or Aurora PostgreSQL — AWS Blue/Green Deployments don't support other engines.</small>
          </div>
          <div class="help-item">
            <p class="help-item-title">What happens next</p>
            <small class="text-muted">On creation, the worker runs the full upgrade in one pass: snapshot,
              parameter group clone, Blue/Green create, validation, switchover, and cleanup. Check the Result
              panel's step history for progress.</small>
          </div>
        </div>

      </div>
    </div>
  `,
})
export class AddRdsUpgradeComponent implements OnInit {
  private readonly svc = inject(RdsUpgradeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly name = signal('');
  protected readonly dbInstanceIdentifier = signal('');
  protected readonly region = signal('');
  protected readonly targetEngineVersion = signal('');
  protected readonly targetInstanceClass = signal('');
  protected readonly targetParameterGroupName = signal('');
  protected readonly switchoverTimeoutMinutes = signal(5);
  protected readonly saving = signal(false);
  protected readonly loading = signal(false);

  protected readonly isEdit = this.route.snapshot.data['action'] === 'Edit';
  private readonly id: string = this.route.snapshot.params['id'];

  // The platform's error reporter: the `form-group-errors` directive (already on the <form> for client-side
  // validation) also implements ErrorReporter. reportError(err) unwraps the API error via extractErrorMessage
  // (reads the response `errors` detail, not just the generic `message` title) and shows it as the form's
  // summary banner — the same pattern the portal's own add-forms use. Do NOT read e.error.message directly.
  private readonly formErrors = viewChild(FormGroupErrorsComponent);

  ngOnInit(): void {
    if (!this.isEdit) {
      return;
    }
    this.loading.set(true);
    this.svc.get(this.id).subscribe({
      next: item => {
        this.name.set(item?.name ?? '');
        this.dbInstanceIdentifier.set(item?.spec?.dbInstanceIdentifier ?? '');
        this.region.set(item?.spec?.region ?? '');
        this.targetEngineVersion.set(item?.spec?.targetEngineVersion ?? '');
        this.targetInstanceClass.set(item?.spec?.targetInstanceClass ?? '');
        this.targetParameterGroupName.set(item?.spec?.targetParameterGroupName ?? '');
        this.switchoverTimeoutMinutes.set(item?.spec?.switchoverTimeoutMinutes ?? 5);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  protected submit(): void {
    this.saving.set(true);
    const spec = {
      dbInstanceIdentifier: this.dbInstanceIdentifier(),
      region: this.region(),
      targetEngineVersion: this.targetEngineVersion(),
      targetInstanceClass: this.targetInstanceClass() || undefined,
      targetParameterGroupName: this.targetParameterGroupName() || undefined,
      switchoverTimeoutMinutes: this.switchoverTimeoutMinutes(),
      // STOPGAP: no scope picker in v1 yet (EXTENSION_BACKLOG.md #36 follow-up) -- hardcoded to the
      // aws-test21-admin scope on prasanna-ws for testing. Replace with a real scope picker before
      // this is used against any other workspace/scope.
      scopeIds: ['69b2aa5a675718845bfe87ce'],
    };
    const call = this.isEdit
      ? this.svc.update(this.id, spec)
      : this.svc.create(this.name(), spec);
    call.subscribe({
      next: () => this.back(),
      error: (err) => {
        this.saving.set(false);
        this.formErrors()?.reportError(err);
      },
    });
  }

  protected cancel(): void {
    this.back();
  }

  // 'add' is one URL segment, 'edit/:id' is two — climb the right number to land back on the list.
  private back(): void {
    this.router.navigate([this.isEdit ? '../..' : '..'], { relativeTo: this.route });
  }
}
