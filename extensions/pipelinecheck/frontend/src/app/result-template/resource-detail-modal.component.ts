import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { SubTemplate, TemplateGroup, TemplateField } from './result-view-template.model';

/**
 * Generic detail popup opened when the user clicks a drillable table row.
 * Renders sub-template groups with the row object as the data context (`{ row }`),
 * so all field paths in sub-templates use the `row.*` prefix.
 */
@Component({
  selector: 'app-resource-detail-modal',
  styles: [`
    .group-panel { padding-top: 8px; }
    .single-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
  `],
  template: `
    <div class="modal-header">
      <div>
        <h4 class="modal-title">{{ title }}</h4>
        <div *ngIf="subtitle" class="text-muted small">{{ subtitle }}</div>
      </div>
    </div>
    <div class="modal-body">
      <div class="nav-scroll">
        <ul ngbNav #nav="ngbNav" [(activeId)]="activeGroup" class="nav nav-tabs flat-tabs">
          <li *ngFor="let g of groups; let i = index" ngbNavItem [ngbNavItem]="i.toString()">
            <a ngbNavLink>{{ g.name }}</a>
            <ng-template ngbNavContent>
              <div class="group-panel">
                <div *ngIf="singleFields(g).length" class="single-grid">
                  <app-field-renderer
                    *ngFor="let f of singleFields(g)"
                    [field]="f"
                    [data]="rowData"
                    [subTemplates]="subTemplates">
                  </app-field-renderer>
                </div>
                <app-field-renderer
                  *ngFor="let f of otherFields(g)"
                  [field]="f"
                  [data]="rowData"
                  [subTemplates]="subTemplates">
                </app-field-renderer>
              </div>
            </ng-template>
          </li>
        </ul>
      </div>
      <div [ngbNavOutlet]="nav" class="mt-1"></div>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-secondary" (click)="modal.dismiss()">Close</button>
    </div>
  `,
  standalone: false,
  // Angular 22 defaults to OnPush; these components assign plain fields from subscribe handlers.
  changeDetection: ChangeDetectionStrategy.Eager
})
export class ResourceDetailModalComponent {
  @Input() title = '';
  @Input() subtitle?: string;
  @Input() row: any;
  @Input() groups: TemplateGroup[] = [];
  @Input() subTemplates?: Record<string, SubTemplate>;

  activeGroup = '0';

  get rowData(): any { return { row: this.row }; }

  constructor(public modal: NgbActiveModal) {}

  singleFields(g: TemplateGroup): TemplateField[] {
    return g.fields.filter(f => f.type === 'single');
  }

  otherFields(g: TemplateGroup): TemplateField[] {
    return g.fields.filter(f => f.type !== 'single');
  }
}
