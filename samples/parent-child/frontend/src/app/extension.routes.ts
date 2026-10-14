import { Routes } from '@angular/router';
import { ListParentsComponent } from './parents/list-parents.component';
import { AddParentComponent } from './parents/add-parent.component';
import { ViewParentComponent } from './parents/view-parent.component';
import { AddChildComponent } from './children/add-child.component';
import { ViewChildComponent } from './children/view-child.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
//
// A `Routes` array, not an NgModule: Angular's `loadChildren` accepts either, and the host's
// extension-route-registrar resolves the export named `Extension` and hands it straight to loadChildren.
// The components are standalone and declare their own `imports`, so there is nothing left for a module
// to do. THE EXPORTED CONST MUST STILL BE NAMED `Extension`.
//
// A single mount (`extensions/hello-parents`) handles parent list/add/view plus the nested child
// add/view (Pattern B from reference/08).
export const Extension: Routes = [
  { path: '', component: ListParentsComponent },
  { path: 'add', component: AddParentComponent },
  // Add and Edit share one component (platform convention); `action` drives the labels. Edits PATCH the
  // FULL spec so the existing provisioning ticket is reused (reference/04-hooks.md).
  { path: 'edit/:id', component: AddParentComponent, data: { action: 'Edit' } },
  { path: 'view/:parentId', component: ViewParentComponent },
  { path: 'view/:parentId/children/add', component: AddChildComponent },
  { path: 'view/:parentId/children/edit/:childId', component: AddChildComponent, data: { action: 'Edit' } },
  { path: 'view/:parentId/children/:childId', component: ViewChildComponent },
];
