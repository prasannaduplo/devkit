import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// Host-provided string DI tokens (no @common-lib import). REMOTE_DuploHttpClient exposes get/post
// returning RxJS Observables; REMOTE_UserSession carries the current tenant (.tenant.TenantId) —
// the same source the host's own resources use for the workspace id.
export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

// This is a TYPED resource: the extension ships its own controller, so we call its OWN REST segment.
// originType/subType are used to look up the provisioning ticket via the origin-context endpoint.
const ORIGIN_TYPE = 'HelloWorld';
const SUB_TYPE = 'hello-world';
const REST_SEGMENT = 'extensions/helloworlds';

// The lifecycle fields every ResourceBase serializes — the detail view's phase timeline reads them
// (status → which phase is active; subStatus → its live beat; blockedReason → why the agent is waiting;
// faults → the failure text; updatedAt → when the last phase finished). See reference/19-detail-page.md.
export interface HelloWorld {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  blockedReason?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  spec?: { firstName?: string; lastName?: string };
  result?: { fullName?: string };
}

@Injectable({ providedIn: 'root' })
export class HelloService {
  // inject() with the platform's string DI tokens (use-ng22 rule — no constructor parameters).
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  /** Current workspace/tenant id — from the host UserSession (route params aren't reliable in a federated remote). */
  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private base(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment/${REST_SEGMENT}`;
  }

  // DuploHttpClient does NOT unwrap the envelope: user/data endpoints return {data: …} while tickets/*
  // return bare bodies — normalize both here.
  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);

  list(): Observable<HelloWorld[]> {
    return this.http.get(this.base()).pipe(map((r: any) => {
      const d = this.unwrap(r);
      return (d?.items ?? d ?? []) as HelloWorld[];
    }));
  }

  get(id: string): Observable<HelloWorld> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: { firstName: string; lastName: string }): Observable<HelloWorld> {
    const body = { name, spec };
    return this.http.post(this.base(), body).pipe(map((r: any) => this.unwrap(r)));
  }

  // `PATCH {id}` merges at the ENTITY level (TicketContext/Status preserved → the ticket is reused), but
  // `spec` is replaced WHOLESALE — always send the FULL spec. `PUT` would bind the whole entity from the
  // body and null out TicketContext/Status/Result — see reference/04-hooks.md.
  update(id: string, spec: { firstName: string; lastName: string }): Observable<HelloWorld> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  /** Resolve the provisioning ticket (its `name` is the chat URL segment) via origin-context. */
  ticketName(id: string): Observable<string | null> {
    const url = `/v1/aiservicedesk/tickets/${this.workspaceId()}/origin-context`
      + `?type=${ORIGIN_TYPE}&id=${id}&subType=${SUB_TYPE}`;
    return this.http.get(url).pipe(map((r: any) => this.unwrap(r)?.name ?? null));
  }
}
