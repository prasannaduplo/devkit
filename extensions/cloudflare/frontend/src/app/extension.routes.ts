import { Routes } from '@angular/router';
import { ListCloudflareWatchComponent } from './list/list-cloudflare-watch.component';
import { AddCloudflareWatchComponent } from './add/add-cloudflare-watch.component';
import { ViewCloudflareWatchComponent } from './view/view-cloudflare-watch.component';

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension'). The export MUST be named `Extension`.
export const Extension: Routes = [
  { path: '', component: ListCloudflareWatchComponent },
  { path: 'add', component: AddCloudflareWatchComponent },
  // Add and Edit share one component; editing the spec re-triggers the worker.
  { path: 'edit/:id', component: AddCloudflareWatchComponent, data: { action: 'Edit' } },
  { path: 'view/:id', component: ViewCloudflareWatchComponent },
];
