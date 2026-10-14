# 11 — Deprovisioning & deletion (per provisioning mode)

Getting rid of an extension resource is a **two-step lifecycle**: *deprovision* (tear down the external thing) then
*delete the row*. The base `ResourceServiceBase<TResource,TSpec,TResult>` drives it; your job is to implement the
right seam for your mode and decide whether the row is auto-deleted or retained. Get this wrong and you orphan cloud
objects or leave undeletable rows.

> **The default is DELETE, not retain.** For agent-based and passthrough resources the row is **hard-deleted
> automatically** once teardown reaches `DeProvisioned` (`AutoDeleteOnDeProvision` defaults **`true`**). Worker
> resources delete their own row at the end of the teardown tick. You only keep a row around if you deliberately
> override `AutoDeleteOnDeProvision => false`.

## REST surface
| Call | Effect |
|---|---|
| `GET {id}/can-deprovision` | UX gate — false for imported resources and for statuses outside `{Complete, Failed, WaitingForApproval, DeprovisionFailed}`; also runs your `ValidateCanDeprovisionAsync`. |
| `POST {id}/deprovision` | Starts orchestrated teardown (`202 Accepted`). Branches by the resource's locked provisioning mode (below). |
| `DELETE {id}` | **Hard**-deletes the Mongo row (not soft). Allowed only in a terminal status — `GetDeletableStatuses` defaults to `{New, Failed, DeProvisioned}`. Runs the `OnBeforeDeleteAsync` guard. |

So: **deprovision = tear down backing infra; DELETE = remove the row (only once terminal).** Most of the time you
call `deprovision` and the row is auto-removed for you; `DELETE` is the manual path for rows that were retained or
never provisioned.

## The two seams you control
| Seam | Signature | Meaning |
|---|---|---|
| `ValidateCanDeprovisionAsync` | `public virtual Task ValidateCanDeprovisionAsync(TResource, CancellationToken)` | Throw to **block** deprovision (e.g. children still exist). Default: allow. |
| `AutoDeleteOnDeProvision` | `protected virtual bool AutoDeleteOnDeProvision(TResource? = null)` | When the row reaches `DeProvisioned`, **hard-delete it** (`true`) or **retain for audit** (`false`). **Default: `true` for agent + passthrough, `false` for worker** (the worker deletes its own row, so auto-delete must not double-fire). |

## Per-mode deprovision path

### Agent-based (skill-mapped) — the common case
`POST {id}/deprovision` → `ValidateCanDeprovisionAsync` → status `DeProvisioning` → the platform **reuses the SAME
provisioning ticket** and **force-sends one generic message**:
> *"Deprovision this resource. Tear down all infrastructure managed by this resource."*

Your skill handles that message, deletes what it created, and **POSTs `DeProvisioned`**. The platform then
**hard-deletes the row automatically** (default), so the row disappears when teardown finishes.

**The end-to-end flow (this is the bit people miss):**
```bash
# 1. your deprovision.sh tears down the infra it created, then posts the terminal status:
curl -sf -X POST "$DUPLO_BASE/v1/aiservicedesk/user/data/workspaces/$WS/environment/extensions/<route>/$ID/status" \
     -H "Authorization: Bearer $DUPLO_TOKEN" -H 'Content-Type: application/json' \
     -d '{"status":"DeProvisioned","subStatus":"torn down"}'
# 2. the platform (UpdateStatusAsync) sees status == DeProvisioned and, because
#    AutoDeleteOnDeProvision is true (the agent default), HARD-DELETES the Mongo row for you.
```
No extra call and no C# override are needed to get the delete — it is the default. **To KEEP the row for audit
instead**, override in your service:
```csharp
// Retain the row after DeProvisioned instead of auto-deleting it.
protected override bool AutoDeleteOnDeProvision(Minio? e = null) => false;
```

> The teardown message is **FORCE-sent**: it kills any in-flight agent turn and discards the pending queue,
> and the resource is already `DeProvisioning` before the agent sees it — a mid-run watcher dies here, which
> is exactly why run-locks/heartbeats matter (see samples/network-stack's tf-run.sh).
>
> ⚠️ **There is NO separate "deprovision skill" mapping.** The platform never auto-selects a distinct teardown
> skill — it just sends the generic teardown message to the existing ticket. So **teardown must be reachable from
> the skill(s) you already mapped for provisioning.** Two ways:
> 1. **(preferred)** the provisioning skill also owns teardown — give its `SKILL.md` a **Deprovision** section that
>    reacts to the teardown message and a deterministic teardown script that deletes exactly what provisioning
>    created (idempotent, safe to re-run). See `samples/network-stack/skills/provision-network-stack`
>    (its SKILL.md Deprovision section runs `terraform destroy` via the same `tf-run.sh`). A combined runner
>    like that is an acceptable alternative to a separate `deprovision.sh` — either way the teardown must be
>    idempotent and post `DeProvisioning → DeProvisioned`.
> 2. add a **second skill** (e.g. `deprovision-<x>`) to the **same mapping's `skillNames` list**.
>
> If neither is done, the agent gets "tear down" with no deterministic way to do it and **your provisioned infra
> orphans** while the row disappears. A provisioning skill that only creates is a bug for any resource that makes
> real infra.

**Frontend: the Delete action.** Ship a Delete row action (list) + a ⋮-menu item in the detail header (view) — worked in
`samples/network-stack`'s `list-network-stack.component.ts` / `view-network-stack.component.ts`:
status-aware branch (terminal + provisioned → `POST {id}/deprovision`; never-provisioned/failed with nothing
created → hard `DELETE {id}`; in-flight → refuse with "wait for the current run"), confirmation via the lib's
`DeleteConfirmationModalService.openGeneric(entityType, name, onconfirm, blockUI?, action?)` wrapped in
try/catch with a `window.confirm` fallback (host modal services can throw inside a remote), and any failure
surfaced in the page's error alert — never swallowed. ⚠️ The lib exports TWO `openGeneric`s with DIFFERENT
argument orders: `DeleteConfirmationModalService` (entityType first, requires typing the entity name to
confirm — the one the samples use) vs `ConfirmationModalService` (action first). Don't mix them up.

### Passthrough (single object, synchronous)
`POST {id}/deprovision` → status `DeProvisioning` → your **`DeprovisionDirectAsync`** deletes the external object
synchronously → the base sets status `DeProvisioned` → `AutoDeleteOnDeProvision` (default **`true`**) hard-deletes
the row. So the row vanishes with the object — no status callback involved (there's no agent).
```csharp
protected override async Task DeprovisionDirectAsync(ConfigMapRes e, CancellationToken ct) {
    var k8s = (await _clients.GetKubernetesClientAsync(e.Spec.ScopeIds, ct))!.Value.Client;
    await k8s.DeleteNamespacedConfigMapAsync(e.Name, e.Spec.Namespace, cancellationToken: ct);
}
// AutoDeleteOnDeProvision is already true for passthrough; override => false only to retain the row.
```

### Worker (multi-object, background)
`POST {id}/deprovision` → status `DeprovisionInitiated` (that's all it sets) → the worker tick picks it up →
status `DeProvisioning` → **`DeleteSubResourcesAsync`** deletes children in **reverse dependency order**
(Ingress → Service → Deployment) → **`WaitForDeletionAsync`** polls the cluster until they're gone → **the worker
hard-deletes the row itself**. A worker resource **never enters `DeProvisioned`** and does **not** go through the
`AutoDeleteOnDeProvision` path (that's why its default is `false`) — the worker owns the final delete. It also
defers a child whose parent is mid-deprovision (`ShouldWaitForParentCascadeAsync`).
```csharp
protected override async Task DeleteSubResourcesAsync(AppStack e, IServiceProvider scope, CancellationToken ct) {
    var k8s = (await scope.GetRequiredService<IScopeClientFactory>().GetKubernetesClientAsync(e.Spec.ScopeIds, ct))!.Value.Client;
    await k8s.DeleteNamespacedIngressAsync(e.Name, e.Spec.Namespace, cancellationToken: ct);
    await k8s.DeleteNamespacedServiceAsync(e.Name, e.Spec.Namespace, cancellationToken: ct);
    await k8s.DeleteNamespacedDeploymentAsync(e.Name, e.Spec.Namespace, cancellationToken: ct);
}
protected override async Task<bool> WaitForDeletionAsync(AppStack e, IServiceProvider scope, CancellationToken ct) {
    // return true once the cluster reports all sub-resources gone; the worker re-ticks until then
}
```

### No-teardown / hard-delete (grouping or logical resources)
Some resources have **nothing external to tear down** — they only exist to model or group other rows
(e.g. Terraform's `TfEnvironment` is `IsProvisioningNeeded => false`, `TfDeployment` clones a repo but tears down
nothing). These **do not support deprovision** and go straight to a row delete:
```csharp
// A logical/grouping resource that never provisions infra:
public override Task DeprovisionAsync(string ws, string id, CancellationToken ct)
    => throw new NotSupportedException("This resource has no infrastructure to deprovision; DELETE it directly.");

protected override async Task OnBeforeDeleteAsync(TfEnvironment e, CancellationToken ct)
    => await GuardNoChildrenAsync<TfState>(e.Id, ct);   // refuse while children still exist
```
`DELETE {id}` hard-deletes the row, gated by your `OnBeforeDeleteAsync` (typically a `GuardNoChildrenAsync` cascade
guard, and/or closing a linked ticket). Contrast with a sibling like `TfState`, which **does** provision
(`IsProvisioningNeeded => true`) and deprovisions through the normal agent path (`terraform destroy`, then the
default auto-delete).

## Hooks around teardown
- `OnAfterStatusUpdateAsync` fires on every status callback **immediately before** the auto-delete-on-`DeProvisioned`
  check — override it to react to teardown completion (emit an event, cascade, etc.) before the row is removed.
- `OnBeforeDeleteAsync` / `OnAfterDeleteAsync` wrap the hard row-delete — the place for cascade guards and
  linked-ticket cleanup.

## Edge cases to handle (and document in your resource)
- **Orphans:** if the external delete fails, the cloud object can outlive the row. `DeprovisionAsync` is idempotent
  — retrying is safe; surface failures (status `Failed` / a fault) rather than silently completing.
- **Cascade / children:** use `ValidateCanDeprovisionAsync` (or `OnBeforeDeleteAsync` + `GuardNoChildrenAsync`) to
  block deletion of a parent while children exist, or delete children first. Worker children defer while the parent
  is deprovisioning; `ClusterDeprovisionOrchestrator` / `ResourceGroupOrchestrator` drive children-first cascades.
- **Retain vs delete:** the row is **deleted by default** in every mode. Override `AutoDeleteOnDeProvision => false`
  (agent/passthrough) only when you deliberately want to keep the row for audit — then it stays at `DeProvisioned`
  and must be removed with an explicit `DELETE`.
- **Stuck tickets:** the platform raises `DEPROVISION_TICKET_STOPPED` / `TICKET_TIMEOUT_EXCEEDED` faults when a
  deprovision ticket stalls — your skill should always post a terminal status.

Each `samples/*` README has a **Deprovision** section showing its exact path.
