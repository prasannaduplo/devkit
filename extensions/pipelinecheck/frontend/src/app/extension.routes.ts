import { Routes } from '@angular/router';
import { ListPipelineCheckComponent } from './list/list-pipeline-check.component';
import { AddPipelineCheckComponent } from './add/add-pipeline-check.component';
import { ViewPipelineCheckComponent } from './view/view-pipeline-check.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
//
// A `Routes` array, not an NgModule: Angular's `loadChildren` accepts either, and the host's
// extension-route-registrar resolves the export named `Extension` and hands it straight to loadChildren.
// The components are standalone and declare their own `imports`, so there is nothing left for a module
// to do. THE EXPORTED CONST MUST STILL BE NAMED `Extension`.
export const Extension: Routes = [
  { path: '', component: ListPipelineCheckComponent },
  { path: 'add', component: AddPipelineCheckComponent },
  // Add and Edit share one component (platform convention); `action` drives the labels.
  { path: 'edit/:id', component: AddPipelineCheckComponent, data: { action: 'Edit' } },
  { path: 'view/:id', component: ViewPipelineCheckComponent },
];
