# 12 — Enrichment & live state (fetch real infra state in C#)

"Enrichment" = on a GET, inject **live, non-persisted** state (running pods, an RDS instance's status, a repo's
latest commit) into `Result` before it's returned. Do it in C# with the SDK's scope→client helpers
([10-sdk-api](10-sdk-api.md)) — no agent round-trip.

## How
Override `EnrichResultAsync` on your service and inject `IScopeClientFactory` (or `IScopeCredentials` for a custom
system). It runs inside `GetByIdAsync` before the entity is returned; failures are caught so a GET never 500s on a
transient infra hiccup.
```csharp
public sealed class AppStackService : ResourceServiceBase<AppStack, AppStackSpec, AppStackResult>
{
    private readonly IScopeClientFactory _clients;
    public AppStackService(/* base deps */ IScopeClientFactory clients) { _clients = clients; }

    protected override async Task EnrichResultAsync(AppStack e, CancellationToken ct)
    {
        var k8s = await _clients.GetKubernetesClientAsync(e.Spec.ScopeIds, ct);
        if (k8s is null) return;                                   // no scope attached → leave Result as-is
        var pods = await k8s.Value.Client.CoreV1.ListNamespacedPodAsync(
            e.Spec.Namespace, labelSelector: $"app={e.Spec.AppLabel}", cancellationToken: ct);
        e.Result.Pods = pods.Items.Select(p => new PodInfo(
            p.Metadata.Name, p.Status.Phase,
            p.Status.ContainerStatuses?.All(c => c.Ready) ?? false)).ToList();
    }
}
```
Rules of thumb: **Result holds live data, Spec holds desired config.** Don't persist enriched fields as truth;
re-fetch each GET. Keep enrichment fast (it's on the read path) and never log credentials.

## Enrichment composes with ANY provisioning mode
`EnrichResultAsync` runs unconditionally inside `GetByIdAsync` — it is **independent of how the resource is
provisioned**. So you can combine it with any mode:
- **observe-only** (`IsProvisioningNeeded => false`): nothing is provisioned; enrichment is the only thing
  that fills `Result` — a pure live-state-viewer resource (same `EnrichResultAsync` seam as
  `samples/network-stack`, just with no provisioning behind it).
- **agent-provisioned** (a skill is mapped): the skill applies the infra and writes the provisioning outputs
  (`POST {id}/results`); enrichment then **augments** `Result` with live state on every read. Don't override
  `IsProvisioningNeeded` — leaving it default keeps the agent path; just add `EnrichResultAsync`. The provision
  skill and the enrichment fill **different** Result fields (skill: deployment/service names + endpoints;
  enrichment: the live pods).
- **passthrough / worker**: same — enrichment layers live state on top of whatever the direct/worker apply wrote.

Worked combined sample (agent provisioning **+** C# enrichment): `samples/network-stack` (its terraform skill
provisions the VPC/subnets; its service's `EnrichResultAsync` reads live subnet state, rendered on the
Network tab).

## The Result ↔ frontend contract (the part that bites people)
`Result` is stored as a **BSON document**, so **structure is preserved** — a `List<PodInfo>` round-trips as a JSON
**array**, an object as an object. Therefore:
- **Type your Result fields** (`List<PodInfo> Pods`, not `string PodsJson`).
- In the **frontend** panel, read `result.pods` **as an array** — do **not** `JSON.parse()` it. Parsing a field
  that's already structured is the #1
  "nothing renders" bug. (If you ever store real JSON *as a string*, that's the only time to parse — avoid it.)

Worked Result consumption: see `samples/network-stack` (its panels consume `Result` fields directly).

## Always annotate — `[BsonIgnoreExtraElements]`
Put `[BsonIgnoreExtraElements]` on **every concrete** entity/`Spec`/`Result` by default — not only when you
later evolve the schema. Two reasons:
1. **Schema evolution (read side):** when you add/remove a `Spec`/`Result` field, existing Mongo documents
   still carry the old shape; without the attribute a read of an old doc throws
   `An error occurred while deserializing …`.
2. **Write-side drop:** the agent's `POST {id}/results` / `{id}/status` JSON is deserialized into your typed
   class, and any key that doesn't map to a declared `[BsonElement]` property is **silently discarded**. So a
   name mismatch between an agent/terraform output and your property **loses the value** — e.g. a terraform
   output `environment_id` (camelCased to `environmentId`) is dropped if your Result declared
   `cloudServicesEnvironmentId` instead. When a result field "won't persist", check the exact key the agent
   posts against your `[BsonElement]` name first.

Put it on the **concrete** class (inheriting it from `BaseSpec`/`BaseResult` is **not** enough):
```csharp
[BsonIgnoreExtraElements]                 // tolerate fields the class does not declare
public sealed class AppStackSpec : BaseSpec { /* … */ }
[BsonIgnoreExtraElements]
public sealed class AppStackResult : BaseResult { public List<PodInfo> Pods { get; set; } = new(); }
```

## The Result ↔ view contract
The view reads the result blob your `*Result` model serializes — nothing in between. Keep the two in
step: a field you add to `Result` gets a tile (or a table, or a tab) in the hand-written view
([17-custom-result-views](17-custom-result-views.md) · [19-detail-page](19-detail-page.md)), and a
field the view reads must exist on the model, camelCased by the serializer (`Result.Pods` →
`result.pods`). Live-state fields that drive the **lifecycle timeline** (a `loadedAt`, a run log, a
`vpcId`) are what let the rail say a phase actually happened rather than inferring it from status —
design them in when you settle the Result table, not after.
