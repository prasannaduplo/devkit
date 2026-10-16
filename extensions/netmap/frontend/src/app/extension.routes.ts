import { Routes } from '@angular/router';
import { ListNetworkMapComponent } from './list/list-network-map.component';
import { AddNetworkMapComponent } from './add/add-network-map.component';
import { ViewNetworkMapComponent } from './view/view-network-map.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
// THE EXPORTED CONST MUST STILL BE NAMED `Extension`.
export const Extension: Routes = [
  { path: '', component: ListNetworkMapComponent },
  { path: 'add', component: AddNetworkMapComponent },
  { path: 'edit/:id', component: AddNetworkMapComponent, data: { action: 'Edit' } },
  { path: 'view/:id', component: ViewNetworkMapComponent },
];
