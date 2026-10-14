import { Routes } from '@angular/router';
import { ListConfigMapComponent } from './list/list-configmap.component';
import { AddConfigMapComponent } from './add/add-configmap.component';
import { ViewConfigMapComponent } from './view/view-configmap.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
//
// A `Routes` array, not an NgModule: Angular's `loadChildren` accepts either, and the host's
// extension-route-registrar resolves the export named `Extension` and hands it straight to loadChildren.
// The components are standalone and declare their own `imports`, so there is nothing left for a module
// to do. THE EXPORTED CONST MUST STILL BE NAMED `Extension`.
export const Extension: Routes = [
  { path: '', component: ListConfigMapComponent },
  { path: 'add', component: AddConfigMapComponent },
  { path: 'edit/:id', component: AddConfigMapComponent },
  { path: 'view/:id', component: ViewConfigMapComponent },
];
