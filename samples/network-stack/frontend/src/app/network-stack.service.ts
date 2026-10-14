import { Injectable, inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

// Host-provided string DI tokens (no @common-lib import). REMOTE_DuploHttpClient exposes get/post/put/
// patch returning RxJS Observables; REMOTE_UserSession carries the current tenant (.tenant.TenantId).
export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

const ORIGIN_TYPE = 'NetworkStack';
const SUB_TYPE = 'network-stack';
const REST_SEGMENT = 'extensions/network-stacks';
// Ask AI sessions use a DEDICATED subType (never the provisioning one — skill auto-resolution and the
// origin-context lookup key on type+subType) plus metadata.purpose as the declared discriminator.
// See reference/16-ask-ai.md.
const ASKAI_SUB = 'network-stack-askai';
const ASKAI_PURPOSE = 'ask-ai';

export interface NetworkStackSubnet {
  name?: string;
  cidr?: string;
  az?: string;
}

export interface NetworkStackModule {
  key: string;
  label: string;
  status: string;
}

export interface NetworkStackActionEntry {
  action: string;
  requestedAt?: string;
  requestedBy?: string;
  finishedAt?: string;
  status: string;
  summary?: string;
  runId?: string;
  hasDiff?: boolean;
}

// Lifecycle fields every ResourceBase serializes — the detail view's phase timeline reads them
// (status / subStatus / blockedReason / faults / updatedAt) alongside result.actions. See reference/19.
export interface NetworkStack {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  blockedReason?: string;
  faults?: string[];
  createdAt?: string;
  updatedAt?: string;
  spec?: {
    region?: string;
    vpcCidr?: string;
    enableDnsHostnames?: boolean;
    subnets?: NetworkStackSubnet[];
    tags?: Record<string, string>;
    scopeIds?: string[];
    /** Stamped by POST {id}/plan|apply — pending until a run consumes it (see the view's pendingDispatch). */
    lastRequestedAction?: { action?: string; requestedAt?: string; requestedBy?: string };
  };
  result?: {
    vpcId?: string;
    subnetIds?: string[];
    securityGroupId?: string;
    modules?: NetworkStackModule[];
    actions?: NetworkStackActionEntry[];
    lastPlanHasDiff?: boolean;
    liveSubnets?: { subnetId?: string; cidr?: string; availabilityZone?: string; state?: string; availableIps?: number }[];
    applyAllowed?: boolean;
  };
}

/** Per-run metadata from GET {id}/plan-history | apply-history (written by the skill's tf-run.sh). */
export interface RunMeta {
  runId: string;
  ranAt?: string;
  running?: boolean;
  success?: boolean;
  hasDiff?: boolean;
  summary?: string;
  verb?: string;
}

/** An Ask AI chat session on this resource (tickets origin-context/list). See reference/16-ask-ai.md. */
export interface AskAiTicket {
  id?: string;
  name: string;
  title?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  originContext?: { type?: string; id?: string; subType?: string; metadata?: Record<string, string> };
  history?: { statuses?: { status?: string }[] };
}

@Injectable({ providedIn: 'root' })
export class NetworkStackService {
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

  list(): Observable<NetworkStack[]> {
    return this.http.get(this.base()).pipe(map((r: any) => {
      const d = this.unwrap(r);
      return (d?.items ?? d ?? []) as NetworkStack[];
    }));
  }

  get(id: string): Observable<NetworkStack> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: NetworkStack['spec']): Observable<NetworkStack> {
    return this.http.post(this.base(), { name, spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  // PATCH merges at the ENTITY level (TicketContext/Status/Result preserved — the ticket is reused),
  // but `spec` is replaced WHOLESALE: always send the FULL spec. See reference/04-hooks.md.
  update(id: string, spec: NetworkStack['spec']): Observable<NetworkStack> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  /** Hard delete — only for rows that never provisioned anything (reference/11). */
  remove(id: string): Observable<any> {
    return this.http.delete(`${this.base()}/${id}`);
  }

  /** Deprovision — tears down the provisioned infra via the resource's ticket (reference/11). */
  deprovision(id: string): Observable<any> {
    return this.http.post(`${this.base()}/${id}/deprovision`, {});
  }

  /** Resolve the provisioning ticket (its `name` is the chat URL segment) via origin-context. */
  ticketName(id: string): Observable<string | null> {
    const url = `/v1/aiservicedesk/tickets/${this.workspaceId()}/origin-context`
      + `?type=${ORIGIN_TYPE}&id=${id}&subType=${SUB_TYPE}`;
    return this.http.get(url).pipe(map((r: any) => this.unwrap(r)?.name ?? null));
  }

  // ── On-demand actions (Plan / Apply buttons — the backend routes them onto the SAME ticket) ──────

  triggerAction(id: string, action: 'plan' | 'apply'): Observable<any> {
    return this.http.post(`${this.base()}/${id}/${action}`, {});
  }

  planHistory(id: string): Observable<RunMeta[]> {
    return this.http.get(`${this.base()}/${id}/plan-history`).pipe(
      map((r: any) => (this.unwrap(r) ?? []) as RunMeta[]), catchError(() => of([])));
  }

  applyHistory(id: string): Observable<RunMeta[]> {
    return this.http.get(`${this.base()}/${id}/apply-history`).pipe(
      map((r: any) => (this.unwrap(r) ?? []) as RunMeta[]), catchError(() => of([])));
  }

  /** One run's meta + raw ANSI log ({kind} = plans | applies). */
  runDetail(id: string, kind: 'plans' | 'applies', runId: string): Observable<{ meta: RunMeta; log: string } | null> {
    return this.http.get(`${this.base()}/${id}/${kind}/${runId}`).pipe(
      map((r: any) => this.unwrap(r) ?? null), catchError(() => of(null)));
  }

  // ── Ask AI sessions (see reference/16-ask-ai.md) ─────────────────────────────────────────────────
  // User-created chat tickets on this resource — unlimited, distinct from the provisioning ticket by
  // ASKAI_SUB + metadata.purpose. All calls hit the HOST tickets/user-data APIs.

  private ticketsBase(): string {
    return `/v1/aiservicedesk/tickets/${this.workspaceId()}`;
  }

  /** All Ask AI sessions for one resource, newest first. */
  listAskAiTickets(id: string): Observable<AskAiTicket[]> {
    const url = `${this.ticketsBase()}/origin-context/list`
      + `?type=${ORIGIN_TYPE}&id=${id}&subType=${ASKAI_SUB}`;
    return this.http.get(url).pipe(
      map((r: any) => {
        const items = (this.unwrap(r) ?? []) as AskAiTicket[];
        return items
          .filter(t => (t.originContext?.metadata?.['purpose'] ?? ASKAI_PURPOSE) === ASKAI_PURPOSE)
          .sort((a, b) => (b.createdAt || b.updatedAt || '').localeCompare(a.createdAt || a.updatedAt || ''));
      }),
      catchError(() => of([])),
    );
  }

  /**
   * Agent for a new session: the provisioning ticket's aiAgentId when one exists, else the first
   * allowed model's agent (the only path for Worker/Passthrough/No-provision resources).
   */
  resolveAgentId(id: string): Observable<string | null> {
    const url = `${this.ticketsBase()}/origin-context?type=${ORIGIN_TYPE}&id=${id}&subType=${SUB_TYPE}`;
    return this.http.get(url).pipe(
      map((r: any) => this.unwrap(r)?.aiAgentId ?? null),
      catchError(() => of(null)),
      switchMap((agentId: string | null) => agentId ? of(agentId) : this.fallbackAgentId()),
    );
  }

  private fallbackAgentId(): Observable<string | null> {
    const url = `/v1/aiservicedesk/user/data/models/allowed?workspaceId=${this.workspaceId()}`;
    return this.http.get(url).pipe(
      map((r: any) => {
        // /models/allowed is DOUBLE-wrapped: ApiResponse<PagedResponse<LlmModel>> — the models live at
        // .data.items, so one more hop after unwrap() or the find() below sees a non-array and fails.
        const models = (this.unwrap(r)?.items ?? []) as any[];
        return models.find(m => m?.agentIds?.length)?.agentIds[0] ?? null;
      }),
      catchError(() => of(null)),
    );
  }

  /** Workspace scopes — the Ask AI dialog's multi-select AND the Add wizard's scope picker. */
  listScopes(): Observable<{ id: string; name: string }[]> {
    const url = `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/scopes`;
    return this.http.get(url).pipe(
      map((r: any) => ((this.unwrap(r) ?? []) as any[]).map(s => ({ id: s.id, name: s.name }))),
      catchError(() => of([])),
    );
  }

  /** Create an Ask AI session; resolves to the ticket `name` (the chat URL segment). Errors propagate. */
  createAskAiTicket(item: NetworkStack, agentId: string, scopeIds: string[]): Observable<string> {
    const body = {
      title: `Ask AI — ${item.name}`,
      aiAgentId: agentId,
      workspaceId: this.workspaceId(),
      ticketContextForAgent: { scopeIds },
      originContext: {
        type: ORIGIN_TYPE,
        id: item.id,
        subType: ASKAI_SUB,
        metadata: { purpose: ASKAI_PURPOSE },  // all metadata values must be strings
      },
    };
    return this.http.post(this.ticketsBase(), body).pipe(map((r: any) => this.unwrap(r)?.name));
  }

  closeAskAiTicket(name: string): Observable<any> {
    return this.http.put(`${this.ticketsBase()}/${name}/status`, { status: 'closed', disposition: 'resolved' });
  }

  /**
   * Default prefill for the Ask AI dialog's context box — the resource sets the initial context here;
   * the user edits it freely before starting the session.
   */
  buildAskAiContext(item: NetworkStack): string {
    return [
      'Context:',
      `- Resource: NetworkStack "${item.name}" (id ${item.id})`,
      `- Status: ${item.status}${item.subStatus ? ` — ${item.subStatus}` : ''}`,
      `- Region: ${item.spec?.region ?? '—'}, VPC CIDR: ${item.spec?.vpcCidr ?? '—'}`,
      item.result?.vpcId ? `- VPC: ${item.result.vpcId}, subnets: ${(item.result.subnetIds ?? []).join(', ') || '—'}` : null,
      'IMPORTANT: perform READ-ONLY investigation only — do not modify any infrastructure.',
    ].filter(Boolean).join('\n');
  }
}
