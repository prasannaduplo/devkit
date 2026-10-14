import { Routes } from '@angular/router';
import { ListNetworkStackComponent } from './list/list-network-stack.component';
import { AddNetworkStackComponent } from './add/add-network-stack.component';
import { ViewNetworkStackComponent } from './view/view-network-stack.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
// A `Routes` array, not an NgModule — the host's extension-route-registrar resolves the export named
// `Extension` and hands it straight to loadChildren. THE EXPORTED CONST MUST BE NAMED `Extension`.
export const Extension: Routes = [
  { path: '', component: ListNetworkStackComponent },
  { path: 'add', component: AddNetworkStackComponent },
  { path: 'edit/:id', component: AddNetworkStackComponent, data: { action: 'Edit' } },
  { path: 'view/:id', component: ViewNetworkStackComponent },
];
