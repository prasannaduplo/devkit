# Patterns — Custom Functionality Beyond CRUD

CRUD + `status`/`results` come free. Real resources usually need more: lifecycle actions (start/stop),
live cloud state on view, logs/shell, and action buttons in the UI. Here are the platform patterns, each
with a real in-repo reference.

## 1. Custom controller endpoints (lifecycle actions)

Add `[HttpPost]`/`[HttpGet]` actions to your resource controller, alongside the inherited CRUD. The
action resolves the resource, then calls a cloud SDK using the scope's credentials.

**Reference:** `AWSRdsInstancesController`
(`Duplo.AI.DataManagement.DevOps/Controllers/User/AWSRdsInstance/AWSRdsInstancesController.cs`) adds:
```
POST …/environment/awsrdsinstances/{id}/start
POST …/environment/awsrdsinstances/{id}/stop
POST …/environment/awsrdsinstances/{id}/reboot
GET  …/environment/awsrdsinstances/engines        (catalog/helper reads)
```
**MANDATORY pattern — the controller delegates to a service method; the SERVICE holds the SDK client and
the credential machinery.** This is not style: a controller is activated from the extension's **child DI
scope**, which holds your own services plus a fixed bridged set of host services (`ILogger<>`,
`IConfiguration`, `IHttpContextAccessor`, `IHttpClientFactory`, `ITicketService`, `ILocalFileManager`,
`IMongoDatabase`, `ISkillMappingService`, `IResourceProvisioningManager`) — those are fine to inject. What
it does NOT get is the composite child→host provider your SERVICE is built through, so any host service
outside that bridge — `IScopeCredentials`, `IScopeClientFactory`, `AwsHostOperations` — compiles and then
fails at runtime with `Unable to resolve service …` (see [10-sdk-api](10-sdk-api.md) Gotchas). Keep
cloud/credential work in the service.
In an **extension**, declare the action on your controller and delegate. A lifecycle action like this
should require an **explicitly granted named action** rather than plain CRUD — `ALL` verbs never implies
one, so an admin must grant `<feature>.restart` deliberately ([18-access-control](18-access-control.md)):
```csharp
[HttpPost("{id}/restart")]
[AccessControl(Action = "acme.restart", Destructive = true,
    ActionName = "Restart the service",
    Description = "Stops and restarts the running service. In-flight work is dropped.")]
public async Task<IActionResult> Restart(string workspaceId, string id, CancellationToken ct) {
    var entity = await ResourceServiceFacet.GetByIdAsync(id, ct) ?? /* 404 */;
    // Delegate: the SERVICE resolves credentials (IScopeCredentials) and calls the cloud/SaaS client.
    return Ok(await _service.RestartAsync(entity, ct));
}
```
A **catalog read** like `GET …/engines` has no resource instance to authorize against, so it takes no
action and no verb check — mark the intent explicitly with
`[NoResourceAccessCheck(Reason = "Type-level catalog read; no resource instance to authorize against.")]`.

## 2. Live cloud detail on view — `EnrichResultAsync`

To show **current** cloud state (not the last persisted result), override `EnrichResultAsync(entity, ct)`
on your service — it runs inside `GetByIdAsync`, after the row is read, before it's returned. Fetch live
state with the scope credentials and stamp it onto `entity.Result` (in-memory only). This is how a
resource view shows fresh status without a write.

(The first-party `K8sPassthroughServiceBase<…>` — apply a manifest directly, serve live detail from a
source-data cache — is host-internal and **not in the SDK feed**; an extension builds the same shape from
`IScopeClientFactory.GetKubernetesClientAsync` — [10](10-sdk-api.md), worked in `samples/worker-appstack`.)

## 3. Pod logs (Kubernetes)

The platform exposes pod logs as a **workspace + scope-scoped** endpoint your remote can call directly:
```
GET /v1/aiservicedesk/user/data/workspaces/{workspaceId}/scopes/{scopeId}/k8s/pods/{podName}/logs
```
Resolve the workload's `scopeId` from the resource's `spec.scopeIds`, call the endpoint from your panel and
render it (poll while following). Interactive shell is a host feature (the xterm service) with no extension API.

## 4. Surfacing actions in the resource view

Actions live in your hand-written view ([19-detail-page](19-detail-page.md)), placed beside the data
they act on:

- **Resource-wide actions** (Plan / Apply, Restart, Refresh) — `btn btn-sm g-btn-ghost` buttons in the
  page header's `.g-actions`, between the Spec | Result switcher and "Ask agent" (Template G's "Open in
  AWS console" slot). `samples/network-stack` puts Plan and Apply there, with Apply disabled until
  `result.applyAllowed`; the pending/in-flight state disables both and keeps the poll alive (its
  `pendingDispatch()` / `runBusy()`). Never a heading or action bar above the tab strip.
- **Per-row actions** (Logs, Exec on a pod) — a kebab or link in the table row inside the panel that
  renders the collection; the panel calls your endpoint via the injected `REMOTE_DuploHttpClient`.
- **Destructive lifecycle actions** (Deprovision / Delete) — the header's ⋮ dropdown, styled
  `text-danger`, behind the platform `DeleteConfirmationModalService`.
- **"Ask agent"** — the header's primary button in Agent mode; it opens the provisioning ticket. The
  same handler backs "Track status" in the lifecycle rail.

Each such button is a named-action or verb decision on the backend too — see
[18-access-control](18-access-control.md).

## 5. Action buttons in your extension's Angular remote

If your extension ships its own remote (list/add/view), add buttons in the view component that call your
custom backend endpoints via the injected `REMOTE_DuploHttpClient`, or navigate with the shared host
`Router`. (The hello-world remote's "Ask agent" / "Track status" handler is a worked example: it resolves
the ticket name via the tickets origin-context endpoint and navigates to the service-desk chat.) Reach
the host through the `REMOTE_*` string DI tokens; the remote's UI uses the platform library
`@duplocloud-internal/ng-common-lib` (see [02-authoring-guide](02-authoring-guide.md#frontend)).
If the user asks for on-demand chat sessions on a resource, don't invent a custom action — use the Ask AI
pattern ([16-ask-ai](16-ask-ai.md)).

## 6. End-to-end: an extra controller API your remote consumes (the "view logs" pattern)

This is the general recipe for any feature the generic framework doesn't give you — fetching logs/console
output, triggering an external action, reading live metrics. You add an endpoint to **your** controller and call
it from **your** remote. App Services "view logs" is the canonical UX; here it is generalized for an extension.

**Backend — add the action to your `ResourcesController<>` subclass.** It's auto-discovered as an
ApplicationPart, so no host change. Return the standard `ApiResponse<T>` envelope and map failures to
status codes (model on `AWSRdsInstancesController.InvokeLifecycleAsync`). Tenancy is enforced by the
access filter once the controller carries its node declaration ([18-access-control](18-access-control.md))
— the filter resolves the resource's real workspace from stored refs and cross-checks the route — so the
endpoint only needs input validation, not an ownership check.

```csharp
public record ConsoleResponse(string Text, bool Building, int? NextStart);

[HttpGet("{id}/console")]
public async Task<IActionResult> Console(string workspaceId, string id,
        [FromQuery] int start = 0, CancellationToken ct = default) {
    var entity = await ResourceServiceFacet.GetByIdAsync(id, ct);
    if (entity is null) return NotFound();   // tenancy already enforced by the access filter
    try {
        // call the external system using creds resolved from entity.Spec.ScopeIds (see 07-scope-credentials),
        // or read entity.Result for stored output.
        var (text, building, next) = await _svc.FetchConsoleAsync(entity, start, ct);
        return Ok(ApiResponse<ConsoleResponse>.SuccessResult(new(text, building, next)));
    } catch (HttpRequestException ex) {
        return StatusCode(502, ApiResponse<object>.ErrorResult($"upstream error: {ex.Message}"));
    }
}
```

Route: `GET …/workspaces/{workspaceId}/environment/<restSegment>/{id}/console?start=0` — the resource-scoped
prefix and auth are inherited from the base controller.

**Frontend — call it from your remote and render it.** Reach the host HTTP client via the `REMOTE_DuploHttpClient`
string token. Unwrap `r?.data`. Two shapes:

```typescript
// datasource (in your remote)
console(wsId: string, id: string, start = 0): Observable<ConsoleResponse> {
  return this.api.get<ApiSingleResponse<ConsoleResponse>>(
    `/v1/aiservicedesk/user/data/workspaces/${wsId}/environment/builds/${id}/console?start=${start}`
  ).pipe(map(r => r?.data));
}

// (a) a log/console viewer that polls while the job is running — model on kub-pod-logs.component.ts
this.poll$ = interval(3000).pipe(
  takeUntil(this.destroy$),
  switchMap(() => this.ds.console(this.wsId, this.id, this.cursor)),
).subscribe(r => { this.append(r.Text); this.cursor = r.NextStart ?? this.cursor; if (!r.Building) this.stop(); });

// (b) a one-shot action button (e.g. "Trigger build") that POSTs then refreshes
trigger(): void { this.ds.post(`…/${this.id}/trigger`, {}).subscribe(() => this.reload()); }
```

Render in a modal (`NgbModal`, like the AppService logs viewer) or an inline tab in your view — your choice.
Handle errors with the injected error reporter; never print secrets.

**Why this matters for extensions:** the generic resource view only knows spec/result. Anything richer —
streaming logs, live external state, custom operations — is your controller endpoint + your remote consuming it.
The platform doesn't need to know the feature exists.

## 7. Action-driven lifecycle (plan/apply/destroy) with streamed logs + run history

When provisioning is a **repeatable, long-running operation** the user re-triggers (terraform plan/apply/
destroy, a redeploy, a re-sync), model it as **one long-lived ticket per resource** that the agent reconciles
on demand — not a fresh ticket per run.

**Trigger — bump a spec field, don't create a ticket.** Add `POST {id}/actions` (the worked sample splits
this into `POST {id}/plan` + `POST {id}/apply` so RBAC can gate them separately); it records the request on
the spec and returns `202`. Use a **monotonic** timestamp so re-submitting the same verb still registers as a
change:
```csharp
entity.Spec.LastRequestedAction = new RequestedAction { Action = action, RequestedAt = DateTime.UtcNow };
await UpdateAsync(id, entity, ct);   // → OnAfterUpdateAsync → NotifySpecChangeAsync → existing ticket reconciles
```
Because this loads the full entity and only mutates one field, `TicketContext` is preserved and the SDK reuses
the ticket (see [04-hooks: Editing a provisioned resource](04-hooks.md)). Require a ticket to already exist
(reject with a clear message if `TicketContext?.TicketId` is empty — actions run *after* first provisioning).

**Logs + history — files in the ticket workdir.** The agent writes each run to
`canvas-documents/{plans,applies}/<runId>.log` (+ a `<runId>.meta.json` with `{runId, ranAt, running, success,
summary}`). The backend serves them by reading the ticket's files — keyed off `entity.TicketContext.TicketId`:
```csharp
using var scope = _scopes.CreateScope();
var ts = scope.ServiceProvider.GetRequiredService<ITicketService>();
var files = await ts.ListTicketFilesAsync(ticketId, "canvas-documents/plans", ct);   // + GetTicketFileAsync(...)
```
Expose `GET {id}/plan-history | apply-history | plans/{runId} | applies/{runId}`. The remote lists runs and
tails the selected log (poll while `meta.running`), rendering ANSI via an `ansiStrip` pipe with a download
button.

**Idempotency + concurrency (agent skill).** Stamp the processed `requestedAt` to a file (e.g.
`shared/.last-action-processed`) and skip if unchanged, so repeated "spec updated" reconcile messages don't
double-run; guard concurrent applies with a run-lock (`shared/.run-lock`).

**Gotcha:** run history is keyed by `TicketContext.TicketId`, so if an edit spawns a *new* ticket (the PUT bug
in [04-hooks](04-hooks.md)) the prior logs vanish from the UI even though they still exist under the old ticket.

**Worked in-repo example:** [`samples/network-stack`](../../../../samples/network-stack) — `POST {id}/plan` +
`POST {id}/apply` (split routes so RBAC can gate them separately; same stamp-the-spec mechanics), run
history + log endpoints reading the ticket workdir, the skill's background terraform run with progressive
status posts, and the Logs tab's live tail.

---

**Summary:** lifecycle action → custom controller endpoint with a named access action; live state →
`EnrichResultAsync`; logs → the workspace/scope k8s endpoint; UI actions → header ghost buttons or in-panel
actions in your own view (§4); **any out-of-framework feature → your own `[HttpGet/Post]` endpoint + your remote
calling it via `REMOTE_DuploHttpClient` (§6)**. All reuse existing platform machinery; none require host changes.
