import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { ResourceTemplateViewComponent } from './resource-template-view.component';
import { FieldRendererComponent } from './field-renderer.component';
import { ResourceDetailModalComponent } from './resource-detail-modal.component';

// VENDORED result renderer — a verbatim copy of the host's resource-template-view, decoupled from
// AISharedComponentModule (it only needs CommonModule + ng-bootstrap). Exposes <app-resource-template-view>.
//
// This exists ONLY because @duplocloud-internal/ng-common-lib does not yet export the renderer. Once the
// lib exports ResourceTemplateViewModule (Part 3a), delete this folder and import that module instead —
// the <app-resource-template-view> usage in the view components stays the same.
@NgModule({
  declarations: [
    ResourceTemplateViewComponent,
    FieldRendererComponent,
    ResourceDetailModalComponent,
  ],
  exports: [
    ResourceTemplateViewComponent,
    FieldRendererComponent,
    ResourceDetailModalComponent,
  ],
  imports: [
    CommonModule,
    NgbModule,
  ],
})
export class ResultTemplateModule {}
