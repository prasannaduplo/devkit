import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

const ORIGIN_TYPE = 'CalcWorker';
const SUB_TYPE = 'calc-worker';
const REST_SEGMENT = 'extensions/calcworkers';

export interface CalculatorSpec {
  a?: number;
  b?: number;
}

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
export interface Calculator {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  workerState?: WorkerState;
  spec?: CalculatorSpec;
  result?: { sum?: number; product?: number };
}

@Injectable({ providedIn: 'root' })
export class CalculatorService {
  // inject() with the platform's string DI tokens (use-ng22 rule — no constructor parameters).
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private base(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment/${REST_SEGMENT}`;
  }

  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);

  list(): Observable<Calculator[]> {
    return this.http.get(this.base()).pipe(map((r: any) => {
      const d = this.unwrap(r);
      return (d?.items ?? d ?? []) as Calculator[];
    }));
  }

  get(id: string): Observable<Calculator> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: CalculatorSpec): Observable<Calculator> {
    const body = { name, spec };
    return this.http.post(this.base(), body).pipe(map((r: any) => this.unwrap(r)));
  }

  // Edit = `PATCH {id}` with the FULL spec: PATCH merges top-level entity fields (TicketContext/Status/
  // Result preserved) but `spec` is replaced WHOLESALE — never send a partial spec, never echo `result`,
  // never PUT (PUT binds the whole entity and nulls TicketContext). A spec change is exactly what
  // re-ticks the background worker (SpecVersion changes → the worker re-applies).
  update(id: string, spec: CalculatorSpec): Observable<Calculator> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }
}
