import { Routes } from '@angular/router';
import { ListAppStackComponent } from './list/list-appstack.component';
import { AddAppStackComponent } from './add/add-appstack.component';
import { ViewAppStackComponent } from './view/view-appstack.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
//
// A `Routes` array, not an NgModule: Angular's `loadChildren` accepts either, and the host's
// extension-route-registrar resolves the export named `Extension` and hands it straight to loadChildren.
// The components are standalone and declare their own `imports`, so there is nothing left for a module
// to do. THE EXPORTED CONST MUST STILL BE NAMED `Extension`.
export const Extension: Routes = [
  { path: '', component: ListAppStackComponent },
  { path: 'add', component: AddAppStackComponent },
  { path: 'edit/:id', component: AddAppStackComponent },
  { path: 'view/:id', component: ViewAppStackComponent },
];
