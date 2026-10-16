import { Routes } from '@angular/router';
import { BlueprintDetailComponent } from './detail/blueprint-detail.component';
import { EditBlueprintComponent } from './edit/edit-blueprint.component';
import { ListBlueprintsComponent } from './list/list-blueprints.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension').
// THE EXPORTED CONST MUST STILL BE NAMED `Extension`.
export const Extension: Routes = [
  { path: '', component: ListBlueprintsComponent },
  { path: 'add', component: EditBlueprintComponent },
  { path: 'edit/:id', component: EditBlueprintComponent, data: { action: 'Edit' } },
  { path: 'view/:id', component: BlueprintDetailComponent },
];
