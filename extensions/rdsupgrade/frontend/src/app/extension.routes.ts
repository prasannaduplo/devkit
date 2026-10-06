import { Routes } from '@angular/router';
import { ListRdsUpgradeComponent } from './list/list-rds-upgrade.component';
import { AddRdsUpgradeComponent } from './add/add-rds-upgrade.component';
import { ViewRdsUpgradeComponent } from './view/view-rds-upgrade.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
//
// A `Routes` array, not an NgModule: Angular's `loadChildren` accepts either, and the host's
// extension-route-registrar resolves the export named `Extension` and hands it straight to loadChildren.
// The components are standalone and declare their own `imports`, so there is nothing left for a module
// to do. THE EXPORTED CONST MUST STILL BE NAMED `Extension`.
export const Extension: Routes = [
  { path: '', component: ListRdsUpgradeComponent },
  { path: 'add', component: AddRdsUpgradeComponent },
  // Add and Edit share one component (platform convention); `action` drives the labels.
  { path: 'edit/:id', component: AddRdsUpgradeComponent, data: { action: 'Edit' } },
  { path: 'view/:id', component: ViewRdsUpgradeComponent },
];
