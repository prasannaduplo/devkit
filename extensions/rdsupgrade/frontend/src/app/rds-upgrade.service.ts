import { Injectable, Inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

// Host-provided string DI tokens (no @common-lib import). REMOTE_DuploHttpClient exposes get/post
// returning RxJS Observables; REMOTE_UserSession carries the current tenant (.tenant.TenantId) —
// the same source the host's own resources use for the workspace id.
export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

// This is a TYPED resource: the extension ships its own controller, so we call its OWN REST segment.
// originType/subType are used to look up the provisioning ticket via the origin-context endpoint.
const ORIGIN_TYPE = 'RdsUpgrade';
const SUB_TYPE = 'rds-upgrade';
const REST_SEGMENT = 'extensions/rdsupgrades';
// REST_SEGMENT MUST equal the manifest `resources[].restSegment` AND the controller `[Route]` — i.e. the
// FULL namespaced path `extensions/<feature>-<resource>`, NOT a bare leaf. base() interpolates it into
// `…/environment/${REST_SEGMENT}`, so omitting the `extensions/` prefix makes every data call 404. See
// reference/00-naming.md.

export interface RdsUpgradeStep {
  phase: string;
  startedAt: string;
  completedAt?: string;
  status: string;
  message?: string;
}

export interface RdsUpgradeSpec {
  dbInstanceIdentifier?: string;
  region?: string;
  targetEngineVersion?: string;
  targetInstanceClass?: string;
  targetParameterGroupName?: string;
  switchoverTimeoutMinutes?: number;
  scopeIds?: string[];
}

export interface RdsUpgradeResult {
  phase?: string;
  stepHistory?: RdsUpgradeStep[];
  sourceEngine?: string;
  sourceEngineVersion?: string;
  snapshotIdentifier?: string;
  parameterGroupName?: string;
  blueGreenDeploymentId?: string;
  greenInstanceIdentifier?: string;
  greenEndpoint?: string;
  oldInstanceIdentifier?: string;
  finalEndpoint?: string;
  errorMessage?: string;
}

export interface RdsUpgrade {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  createdAt?: string;
  spec?: RdsUpgradeSpec;
  result?: RdsUpgradeResult;
}

@Injectable({ providedIn: 'root' })
export class RdsUpgradeService {
  constructor(
    @Inject(REMOTE_DuploHttpClient) private http: any,
    @Inject(REMOTE_UserSession) private session: any,
  ) {}

  /** Current workspace/tenant id — from the host UserSession (route params aren't reliable in a MF remote). */
  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private base(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment/${REST_SEGMENT}`;
  }

  // The DuploHttpClient unwraps the API envelope to `data`; fall back defensively for either shape.
  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);

  list(): Observable<RdsUpgrade[]> {
    return this.http.get(this.base()).pipe(map((r: any) => {
      const d = this.unwrap(r);
      return (d?.items ?? d ?? []) as RdsUpgrade[];
    }));
  }

  get(id: string): Observable<RdsUpgrade> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: RdsUpgradeSpec): Observable<RdsUpgrade> {
    const body = { name, spec };
    return this.http.post(this.base(), body).pipe(map((r: any) => this.unwrap(r)));
  }

  // `PATCH {id}` merges onto the DB entity, so the existing ticket/worker state is reused. `PUT` would bind
  // the whole entity from the body and null out TicketContext/Status/Result — see reference/04-hooks.md.
  update(id: string, spec: RdsUpgradeSpec): Observable<RdsUpgrade> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  /** Resolve the provisioning ticket (its `name` is the chat URL segment) via origin-context. */
  ticketName(id: string): Observable<string | null> {
    const url = `/v1/aiservicedesk/tickets/${this.workspaceId()}/origin-context`
      + `?type=${ORIGIN_TYPE}&id=${id}&subType=${SUB_TYPE}`;
    return this.http.get(url).pipe(map((r: any) => this.unwrap(r)?.name ?? null));
  }

  /**
   * Declarative Result view-template for this resource type (the inherited GET …/view-template endpoint;
   * served from the `resources-frontend-templates/` we ship in the bundle — see 09-result-templates).
   * Resolves to null when none is registered, so the view falls back to plain cards.
   */
  getViewTemplate(type: string = ORIGIN_TYPE, subType: string = SUB_TYPE): Observable<any | null> {
    const q = `type=${encodeURIComponent(type)}&subType=${encodeURIComponent(subType)}`;
    return this.http.get(`${this.base()}/view-template?${q}`).pipe(
      map((r: any) => this.unwrap(r) ?? null),
      catchError(() => of(null)),
    );
  }
}
