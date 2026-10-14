import { Injectable, inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

// Host-provided string DI tokens (no @common-lib import for host services — those come via these tokens).
export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

const PARENT_TYPE = 'HelloParent';
const PARENT_SUB = 'hello-parent';
const PARENT_SEG = 'extensions/hello-parents';
const CHILD_TYPE = 'HelloChild';
const CHILD_SUB = 'hello-child';
const CHILD_SEG = 'hello-children';

// Lifecycle fields every ResourceBase serializes — the detail views' phase timelines read them
// (status / subStatus / blockedReason / faults / updatedAt). See reference/19-detail-page.md.
export interface HelloParent {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  blockedReason?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  spec?: { title?: string };
  result?: { slug?: string };
}

export interface HelloChild {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  blockedReason?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  spec?: { parentId?: string; note?: string };
  result?: { message?: string };
}

@Injectable({ providedIn: 'root' })
export class ParentChildService {
  // inject() with the platform's string DI tokens (use-ng22 rule — no constructor parameters).
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private parentBase(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment/${PARENT_SEG}`;
  }

  private childBase(parentId: string): string {
    return `${this.parentBase()}/${parentId}/${CHILD_SEG}`;
  }

  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);
  private items = (r: any) => { const d = this.unwrap(r); return (d?.items ?? d ?? []); };

  // ── parents ──────────────────────────────────────────────────────────────
  listParents(): Observable<HelloParent[]> {
    return this.http.get(this.parentBase()).pipe(map((r: any) => this.items(r) as HelloParent[]));
  }

  getParent(id: string): Observable<HelloParent> {
    return this.http.get(`${this.parentBase()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  createParent(name: string, title: string): Observable<HelloParent> {
    return this.http.post(this.parentBase(), { name, spec: { title } }).pipe(map((r: any) => this.unwrap(r)));
  }

  // Edit = `PATCH {id}` with the FULL spec: PATCH merges top-level entity fields (TicketContext/Status/
  // Result preserved — the existing ticket is reused) but `spec` is replaced WHOLESALE — never send a
  // partial spec, never echo `result`, never PUT (PUT binds the whole entity and nulls TicketContext).
  updateParent(id: string, spec: HelloParent['spec']): Observable<HelloParent> {
    return this.http.patch(`${this.parentBase()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  // ── children (nested under a parent) ───────────────────────────────────────
  listChildren(parentId: string): Observable<HelloChild[]> {
    return this.http.get(this.childBase(parentId)).pipe(map((r: any) => this.items(r) as HelloChild[]));
  }

  getChild(parentId: string, childId: string): Observable<HelloChild> {
    return this.http.get(`${this.childBase(parentId)}/${childId}`).pipe(map((r: any) => this.unwrap(r)));
  }

  createChild(parentId: string, name: string, note: string): Observable<HelloChild> {
    return this.http.post(this.childBase(parentId), { name, spec: { note } }).pipe(map((r: any) => this.unwrap(r)));
  }

  // FULL spec here too — a child's spec carries the route-stamped `parentId`, which a partial
  // `{ note }` body would silently erase (spec is replaced wholesale on PATCH).
  updateChild(parentId: string, childId: string, spec: HelloChild['spec']): Observable<HelloChild> {
    return this.http.patch(`${this.childBase(parentId)}/${childId}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  // ── provisioning ticket lookup (chat URL segment) ──────────────────────────
  parentTicketName(id: string): Observable<string | null> {
    return this.ticketName(PARENT_TYPE, id, PARENT_SUB);
  }

  childTicketName(id: string): Observable<string | null> {
    return this.ticketName(CHILD_TYPE, id, CHILD_SUB);
  }

  private ticketName(type: string, id: string, subType: string): Observable<string | null> {
    const url = `/v1/aiservicedesk/tickets/${this.workspaceId()}/origin-context`
      + `?type=${type}&id=${id}&subType=${subType}`;
    return this.http.get(url).pipe(map((r: any) => this.unwrap(r)?.name ?? null), catchError(() => of(null)));
  }
}
