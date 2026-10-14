import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

const REST_SEGMENT = 'extensions/cloudflare-watches';

export interface CloudflareWatchSpec {
  scopeIds?: string[];
  scriptNameFilter?: string | null;
  historyLimit?: number;
}

export interface WorkerScriptState {
  name: string;
  createdOn?: string;
  modifiedOn?: string;
  currentDeploymentId?: string;
  currentVersionIds?: string[];
  lastDeployedAt?: string;
  lastDeployedBy?: string;
  lastDeploySource?: string;
  lastDeployMessage?: string;
}

export interface WorkerEvent {
  at: string;
  kind: 'ScriptAdded' | 'ScriptDeleted' | 'Deployed' | string;
  script: string;
  deploymentId?: string;
  versionIds?: string[];
  author?: string;
  source?: string;
  message?: string;
}

export interface CloudflareWatchResult {
  accountId?: string;
  tokenStatus?: string;
  tokenExpiresOn?: string;
  baselineAt?: string;
  appliedFilter?: string;
  lastScannedAt?: string;
  lastError?: string;
  scriptCount?: number;
  pendingScripts?: number;
  scripts?: WorkerScriptState[];
  events?: WorkerEvent[];
  eventCounts?: { added?: number; deleted?: number; deployed?: number };
}

/** Reconcile bookkeeping the worker pipeline stamps on the entity (ResourceBase.WorkerState). */
export interface WorkerState {
  retryCount?: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastVerifiedAt?: string;
  lastFailedCode?: string;
}

// A WORKER resource has no ticket; its progress is status + subStatus + workerState.
export interface CloudflareWatch {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  workerState?: WorkerState;
  spec?: CloudflareWatchSpec;
  result?: CloudflareWatchResult;
}

export interface WorkspaceScope {
  id: string;
  name: string;
  providerId?: string;
}

@Injectable({ providedIn: 'root' })
export class CloudflareWatchService {
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private wsBase(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}`;
  }

  private base(): string {
    return `${this.wsBase()}/environment/${REST_SEGMENT}`;
  }

  // DuploHttpClient does not unwrap the ApiResponse envelope — normalize `{data:…}` and bare bodies.
  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);
  private items = (r: any) => {
    const d = this.unwrap(r);
    return d?.items ?? d ?? [];
  };

  list(): Observable<CloudflareWatch[]> {
    return this.http.get(this.base()).pipe(map((r: any) => this.items(r) as CloudflareWatch[]));
  }

  get(id: string): Observable<CloudflareWatch> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  /** Scopes attached to the workspace — the backend enforces that the chosen one is an Other/Cloudflare scope. */
  scopes(): Observable<WorkspaceScope[]> {
    return this.http.get(`${this.wsBase()}/scopes`).pipe(map((r: any) => this.items(r) as WorkspaceScope[]));
  }

  create(name: string, spec: CloudflareWatchSpec): Observable<CloudflareWatch> {
    return this.http.post(this.base(), { name, spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  // Edit = PATCH {id} with the FULL spec (spec is replaced wholesale; never PUT). A spec change re-ticks the worker.
  update(id: string, spec: CloudflareWatchSpec): Observable<CloudflareWatch> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  delete(id: string): Observable<any> {
    return this.http.delete(`${this.base()}/${id}`);
  }
}
