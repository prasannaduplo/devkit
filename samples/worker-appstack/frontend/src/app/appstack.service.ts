import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// Host-provided string DI tokens (no @common-lib import). REMOTE_DuploHttpClient exposes get/post
// returning RxJS Observables; REMOTE_UserSession carries the current tenant (.tenant.TenantId) —
// the same source the host's own resources use for the workspace id.
export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

// This is a TYPED resource: the extension ships its own controller, so we call its OWN REST segment.
const ORIGIN_TYPE = 'AppStack';
const SUB_TYPE = 'app-stack';
const REST_SEGMENT = 'extensions/appstacks';

/** Reconcile bookkeeping the worker pipeline stamps on the entity (ResourceBase.WorkerState). */
export interface WorkerState {
  retryCount?: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastVerifiedAt?: string;
  lastFailedCode?: string;
}

// Lifecycle fields every ResourceBase serializes — the detail view's phase timeline reads them. A WORKER
// resource has no ticket and no blockedReason; its progress is status + subStatus + workerState.
export interface AppStack {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  workerState?: WorkerState;
  spec?: { namespace?: string; image?: string; replicas?: number; scopeIds?: string[] };
  result?: { deploymentName?: string; serviceName?: string };
}

@Injectable({ providedIn: 'root' })
export class AppStackService {
  // Functional inject() is typed for ProviderToken; the host provides these under STRING keys, so cast.
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  /** Current workspace/tenant id — from the host UserSession (route params aren't reliable in a federated remote). */
  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private base(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment/${REST_SEGMENT}`;
  }

  // DuploHttpClient does NOT unwrap the ApiResponse envelope — `user/data/*` endpoints return `{data:…}`
  // while some others return bare bodies, so normalize both shapes here.
  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);

  list(): Observable<AppStack[]> {
    return this.http.get(this.base()).pipe(map((r: any) => {
      const d = this.unwrap(r);
      return (d?.items ?? d ?? []) as AppStack[];
    }));
  }

  get(id: string): Observable<AppStack> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: AppStack['spec']): Observable<AppStack> {
    const body = { name, spec };
    return this.http.post(this.base(), body).pipe(map((r: any) => this.unwrap(r)));
  }

  // PATCH merges top-level entity fields (TicketContext/Status/Result preserved) BUT `spec` is replaced
  // WHOLESALE — always send the FULL spec object, and never echo `result` back. Never use PUT: it binds
  // the whole entity and nulls TicketContext (reference/04-hooks). A spec change is what re-triggers the
  // background worker's reconcile.
  update(id: string, spec: AppStack['spec']): Observable<AppStack> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }
}
