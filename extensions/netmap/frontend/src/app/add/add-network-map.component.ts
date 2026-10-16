import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormGroupErrorsComponent, SharedFormsModule } from '@duplocloud-internal/ng-common-lib';
import { NetworkMapService } from '../network-map.service';

@Component({
  selector: 'nm-add',
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
          <h4 class="font-weight-bolder">{{ isEdit ? 'Edit' : 'Create' }} Network Map</h4>
          <p class="panel-content-title-sub-text text-muted">
            Scans an AWS region's VPCs live — no provisioning, nothing is created or changed in AWS.
          </p>
        </div>

        <div class="panel-content-form">
          @if (loading()) {
            <div class="text-muted p-1">Loading…</div>
          } @else {
            <form name="AddNetworkMapForm" #f="ngForm" class="form form-vertical" (ngSubmit)="f.valid && submit()">
              <div class="form-container" form-group-errors #formGroupErrors showDetailsWhen="submitted">
                <form-field>
                  <label class="element-label">Name *</label>
                  <input type="text" class="form-control" name="name"
                         [ngModel]="name()" (ngModelChange)="name.set($event)" [readonly]="isEdit"
                         placeholder="e.g. prod-network" required validation-state validation-errors
                         minlength="2" maxlength="60" pattern="^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$" />
                </form-field>
                <form-field>
                  <label class="element-label">AWS Region *</label>
                  <input type="text" class="form-control" name="region"
                         [ngModel]="region()" (ngModelChange)="region.set($event)"
                         placeholder="e.g. us-east-1" required validation-state validation-errors />
                </form-field>

                <div class="d-flex justify-content-end mt-1">
                  <button type="button" class="btn btn-outline-secondary mr-1" (click)="cancel()">Cancel</button>
                  <button type="submit" class="btn btn-primary" [disabled]="saving()">
                    {{ isEdit ? 'Save' : 'Create' }}
                  </button>
                </div>
              </div>
            </form>
          }
        </div>

        <div class="panel-content-sidenav">
          <div class="help-item">
            <p class="help-item-title">Region</p>
            <small class="text-muted">VPCs are regional — this map covers one region at a time.</small>
          </div>
          <div class="help-item">
            <p class="help-item-title">What happens next</p>
            <small class="text-muted">Opens on an account-level view of every VPC in the region, with a
              live drill-down per VPC showing subnets, resources, and traffic flagged red where a security
              group allows inbound or outbound access from anywhere.</small>
          </div>
        </div>

      </div>
    </div>
  `,
})
export class AddNetworkMapComponent implements OnInit {
  private readonly svc = inject(NetworkMapService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly name = signal('');
  protected readonly region = signal('us-east-1');
  protected readonly saving = signal(false);
  protected readonly loading = signal(false);

  protected readonly isEdit = this.route.snapshot.data['action'] === 'Edit';
  private readonly id: string = this.route.snapshot.params['id'];

  private readonly formErrors = viewChild(FormGroupErrorsComponent);

  ngOnInit(): void {
    if (!this.isEdit) {
      return;
    }
    this.loading.set(true);
    this.svc.get(this.id).subscribe({
      next: item => {
        this.name.set(item?.name ?? '');
        this.region.set(item?.spec?.region ?? '');
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  protected submit(): void {
    this.saving.set(true);
    const spec = {
      region: this.region(),
      // STOPGAP: no scope picker in v1 yet (same gap rdsupgrade has) -- hardcoded to the aws-test21-admin
      // scope in the dev workspace for testing. Replace with a real scope picker before use elsewhere.
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

  private back(): void {
    this.router.navigate([this.isEdit ? '../..' : '..'], { relativeTo: this.route });
  }
}
