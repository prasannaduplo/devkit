# 10 — SDK API reference: cloud access from extension C# (`Duplo.Ai.Studio.Extensibility.Infra`)

This package ships in the SDK feed (`Duplocloud.AiHelpdesk.Sdk`) and is registered by the host, so your extension
**service or worker** can **inject** these to read scope credentials and talk to live infrastructure (Kubernetes,
AWS, GitHub) from your own C# — exactly what `EnrichResultAsync`, passthrough provisioning, and custom actions need.
Add no extra reference for it; it comes with the SDK. (For per-AWS-service calls, add the `AWSSDK.<Service>`
package you use — see `CreateAwsClientAsync`.)

> Namespace: `Duplo.Ai.Studio.Extensibility.Infra`. `ProviderCategory` (and `Provider`/`Scope`) live in
> `Duplo.Ai.Model` — add `using Duplo.Ai.Model;` next to `using Duplo.Ai.Studio.Extensibility.Infra;`.
> Inject `IScopeCredentials` and/or `IScopeClientFactory` via the constructor of your **service/worker ONLY —
> never a controller**: a hot-loaded controller is activated from the extension's CHILD scope (your own
> services + a fixed bridged set: `ILogger<>`, `IConfiguration`, `IHttpContextAccessor`, `IHttpClientFactory`,
> `ITicketService`, `ILocalFileManager`, `IMongoDatabase`, `ISkillMappingService`,
> `IResourceProvisioningManager` — those inject fine), WITHOUT the composite child→root provider, so a host
> service outside that bridge compiles clean and then fails at runtime with
> `Unable to resolve service for type 'IScopeCredentials' while attempting to activate '<YourController>'`.
> The controller injects your extension's own service and delegates (see [05-custom-actions](05-custom-actions.md)).
> **Never log credential values** (`ResolvedScope.Data`, tokens).

---

## `IScopeCredentials` — read decrypted credentials for ANY scope
Use when you talk to a system yourself (a custom/`other` provider — Jenkins, Datadog, an internal API): resolve the
scope, read its base URL + token from `Data`, call the API.

### `Task<IReadOnlyList<ResolvedScope>> ResolveAsync(IEnumerable<string> scopeIds, CancellationToken ct = default)`
- **Purpose:** resolve each attached scope id to its provider/scope + **decrypted** credential data.
- **Params:** `scopeIds` — the resource's `Spec.ScopeIds`; blank ids skipped.
- **Returns:** one `ResolvedScope` per resolvable id.
- **When:** you need every attached scope, or a non-standard category.
- **Example:**
  ```csharp
  foreach (var s in await _creds.ResolveAsync(e.Spec.ScopeIds, ct))
      _log.LogInformation("scope {Name} type {Type}", s.Scope.Name, s.Provider.Type);
  ```

### `Task<ResolvedScope?> FirstOfCategoryAsync(IEnumerable<string> scopeIds, ProviderCategory category, CancellationToken ct = default)`
- **Purpose:** first resolved scope of a category, else `null`.
- **When:** the scope is optional.

### `Task<ResolvedScope> RequireOfCategoryAsync(IEnumerable<string> scopeIds, ProviderCategory category, string notFoundMessage, CancellationToken ct = default)`
- **Purpose:** as above but throws `ArgumentException` (→ HTTP 400) with your message when none is attached.
- **When:** the scope is required to provision/enrich.
- **Example (a custom "other" API — `ProviderCategory` needs `using Duplo.Ai.Model;`):**
  ```csharp
  var s = await _creds.RequireOfCategoryAsync(e.Spec.ScopeIds, ProviderCategory.other, "Attach the Jenkins scope.", ct);
  var baseUrl = s.Provider.AccountId;                 // by convention the base URL
  var token   = s.Data["apiToken"];                   // decrypted
  ```

### `record ResolvedScope(Provider Provider, Scope Scope, IReadOnlyDictionary<string,string> Data)`
- `Provider` — `Type`, `Category`, `AccountId`. `Scope` — `Name`, `CredentialName`, `ResourceMap`.
- `Data` — decrypted credential values, case-insensitive (e.g. `baseUrl`, `username`, `apiToken`,
  `accessKeyId`/`secretAccessKey`/`sessionToken`).

---

## `IScopeClientFactory` — ready-to-use cloud clients

### `Task<K8sScopeClient?> GetKubernetesClientAsync(IEnumerable<string> scopeIds, CancellationToken ct = default)`
- **Purpose:** a live `IKubernetes` client for the attached kubernetes scope (JIT token handled), else `null`.
- **Returns:** `K8sScopeClient(IKubernetes Client, Provider, Scope)`. Dispose the client when done.
- **When:** enrich with live pod/deployment state, or passthrough-provision a k8s object.
- **Example:**
  ```csharp
  var k8s = await _clients.GetKubernetesClientAsync(e.Spec.ScopeIds, ct);
  if (k8s is null) return;                            // no scope → leave Result as-is
  var pods = await k8s.Value.Client.CoreV1.ListNamespacedPodAsync(e.Spec.Namespace, labelSelector: $"app={e.Spec.AppLabel}", cancellationToken: ct);
  ```

### `Task<AwsContext> ResolveAwsContextAsync(IEnumerable<string> scopeIds, string region, string? assumeRoleArn = null, CancellationToken ct = default)`
- **Purpose:** AWS credentials + region from the cloud scope (optional cross-account assume-role).
- **Throws:** `ArgumentException` if no cloud scope / blank region.
- **When:** you need raw `AWSCredentials`.

### `Task<T> CreateAwsClientAsync<T>(IEnumerable<string> scopeIds, string region, Func<AWSCredentials,RegionEndpoint,T> factory, string? assumeRoleArn = null, CancellationToken ct = default) where T : AmazonServiceClient`
- **Purpose:** build a typed AWS client. **Your extension adds the `AWSSDK.<Service>` package** and passes the ctor.
- **When:** call any AWS service (RDS/EC2/S3/…).
- **Example:**
  ```csharp
  using var rds = await _clients.CreateAwsClientAsync(e.Spec.ScopeIds, e.Spec.Region, (c, r) => new AmazonRDSClient(c, r), ct: ct);
  var dbs = await rds.DescribeDBInstancesAsync(new() { DBInstanceIdentifier = e.Spec.DbId }, ct);
  ```

### `Task<GitHubScopeClient?> GetGitHubClientAsync(IEnumerable<string> scopeIds, CancellationToken ct = default)`
- **Purpose:** an `HttpClient` (bearer-authed, GitHub headers) for the source-control scope, else `null`. Dispose `Http`.
- **When:** read/commit files via the GitHub REST API.

## `AwsHostOperations` — EC2 lifecycle + SSM console federation
Inject the singleton `AwsHostOperations`. Stateless; pass scope-resolved `AWSCredentials` + region per call.
- `Task<Ec2ActionResult> StartAsync / StopAsync / RebootAsync(AWSCredentials creds, string region, string instanceId, ct)` — EC2 power actions; result carries the post-call state.
- `Task<string> BuildSsmSessionUrlAsync(AWSCredentials creds, string region, string instanceId, ct)` — a JIT AWS-console federation URL that lands on the instance's SSM Session Manager page (signed with the supplied scope creds, so it's scoped to the tenant's account).
- Resolve the creds with `IScopeClientFactory.ResolveAwsContextAsync(scopeIds, region, assumeRoleArn?)`; needs `AWSSDK.EC2` (already in the SDK closure).

## `AwsRegionUtil` (static) — per-resource region derivation
- `string? ResolveResourceRegion(JsonObject? tfState)` — derive a resource's region **from the resource itself** (ARN segment 3 → `availability_zone` → `region` attr), never from the scope (a scope spans regions; a cross-account assume-role lands elsewhere). Returns null when undeterminable → skip the live fetch.
- `string? RegionFromArn(string? arn)`, `string ResolveStsRegion()` (`AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`).

## `ICurrentUser` — the logged-in caller
A host singleton (`Email`, `Username`, `OnBehalfOf`, `Roles`, `IsAuthenticated`) that injects into your
service/worker; read it inside a request-scoped call. Full treatment, with the frontend and agent equivalents:
[13-current-user](13-current-user.md).

---

## Exported resource seams you override (in `Duplo.Ai.DataManagement`)
These ship in the SDK already (base `ResourceServiceBase<TResource,TSpec,TResult>` / `ResourceWorkerBase<…>`).
Full firing order + decision guidance: [04-hooks](04-hooks.md); deprovision: [11-deprovisioning](11-deprovisioning.md).

| Seam | Signature (shape) | When to override |
|---|---|---|
| `EnrichResultAsync` | `protected virtual Task EnrichResultAsync(TResource, CancellationToken)` | Inject live, non-persisted state on GET (use `IScopeClientFactory`). |
| `ProvisionDirectAsync` | `protected virtual Task ProvisionDirectAsync(TResource, CancellationToken)` | Passthrough create (no skill mapping → `ProvisionedMode==Passthrough`). |
| `UpdateDirectAsync` | `protected virtual Task UpdateDirectAsync(TResource, CancellationToken)` | Passthrough update (re-apply). |
| `DeprovisionDirectAsync` | `protected virtual Task DeprovisionDirectAsync(TResource, CancellationToken)` | Passthrough delete of the external object. |
| `IsProvisioningNeeded` | `protected virtual bool IsProvisioningNeeded(TResource)` | Return `false` → create completes with no provisioning ticket (on-demand only). |
| `NoSkillsFallbackMode` | `protected virtual ProvisioningMode NoSkillsFallbackMode` | Return `Worker` to use the background worker instead of passthrough. |
| `ValidateSpecAsync` | `protected virtual Task ValidateSpecAsync(...)` | Validate spec / required scope before persist. |
| `AutoDeleteOnDeProvision` | `protected virtual bool AutoDeleteOnDeProvision(TResource?)` | `true` to hard-delete the row when it reaches `DeProvisioned`. Default: `true` for agent + passthrough, `false` for worker. |
| `ValidateCanDeprovisionAsync` | `public virtual Task ValidateCanDeprovisionAsync(...)` | Block deprovision while children/dependents exist. |
| worker `ApplyAsync` / `VerifyDriftAsync` / `DeleteSubResourcesAsync` / `WaitForDeletionAsync` | `protected abstract` on `ResourceWorkerBase<…>` | Worker mode: apply (dependency order), drift-check, delete (reverse), poll-until-gone. |

See worked examples: `samples/network-stack`, `samples/passthrough-configmap`, `samples/worker-appstack`.

## Gotchas
- **Kubernetes calls need `using k8s;`** and go through the grouped operations:
  `client.CoreV1.ListNamespacedPodAsync(...)`, `client.AppsV1.ReadNamespacedDeploymentAsync(...)` — not a flat
  `client.ListNamespacedPodAsync`.
- **AWS:** add the `AWSSDK.<Service>` package you call (e.g. `AWSSDK.RDS`) to your `backend/*.csproj`; the SDK
  pins `AWSSDK.Core` + `AWSSDK.SecurityToken` + `AWSSDK.EC2` (the last for `AwsHostOperations`).
- **Workers start on hot-load; `IDuploExtension.Configure` runs only on boot replay.** The hot-load path cannot
  add to the frozen root container, so it does **not** call `IDuploExtension.Configure`; instead it scans your
  assembly for `IHostedService` implementations and starts them directly, so a `ResourceWorkerBase` ticks as soon as
  the bundle loads. `Configure`'s `AddHostedService<…>()` is what the startup loader uses when it replays persisted
  extensions after a studio restart — ship it, but don't expect anything else you register in `Configure` to be
  available on hot-load.
- **No auxiliary DI on hot-load:** the per-extension child container only provides your manifest resource
  services/hooks + `IRepository<T>` + the host pipeline. So you cannot constructor-inject your OWN helper types
  (e.g. a detail-provider registry) — build them as plain no-DI classes (a `static readonly` instance), passing
  deps per call. **Host singletons DO inject into your SERVICE/WORKER** (`IScopeClientFactory`,
  `IScopeCredentials`, `AwsHostOperations`) via the composite child→root provider — **but NOT into controllers**
  (they get only the child scope + the bridged host set named above, no composite provider): a controller ctor
  takes your extension's own service (plus bridged basics like `ILogger<>`) and delegates, or you get a runtime
  `Unable to resolve service …` the build cannot catch.
- **Bump `manifest.version` to re-load edited code** — [06](06-registration.md#reloading-changed-code--bump-manifestversion).
- **SDK version & NuGet cache:** the SDK is pinned by version (`sdk-version`). If the host SDK is rebuilt with new
  content at the **same** version, NuGet's global cache can serve a stale copy → "type/namespace not found" for new
  SDK APIs. The host bumps the SDK version on any SDK change; if you still hit it, clear the cached package
  (`rm -rf ~/.nuget/packages/duplocloud.aihelpdesk.sdk/<version>`) and rebuild.
