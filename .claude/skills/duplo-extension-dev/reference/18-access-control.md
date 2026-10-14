# Access control — putting your resources under the platform's permission model

The platform authorizes every request against a hierarchical permission model: resources are
**nodes in a tree rooted at the Workspace**, and admins write permission-set rules that grant or
deny **verbs** (GET/PUT/POST/DELETE), **named actions** (explicitly granted capabilities like
"restart" or "open a console"), and cloud **scopes** per node — with subtree cascade and
deny-wins evaluation.

An extension resource joins that model with **one attribute on its controller**. Joining is
**opt-in per resource type** — without the declaration the resource keeps its pre-existing behavior:
it never appears in the permission-set editor, and every allow/deny rule ignores it, meaning any
authenticated workspace member can CRUD it. Declare the node whenever the resource holds anything
an admin might want to restrict (all samples and the scaffold do).

## Pattern A — top-level resource (the default)

```csharp
using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.Model;

[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/helloworlds")]
[AccessControl(Parent = typeof(Workspace), ParentIdProperty = "OwnerWorkspaceId")]
public class HelloWorldsController : ResourcesController<HelloWorld, HelloWorldSpec, HelloWorldResult>
```

That's the whole change, because:

- Every extension entity derives `ResourceBase`, which carries `OwnerWorkspaceId` — the property
  the declaration names. (Spelling `ParentIdProperty` explicitly mirrors every first-party
  declaration on the platform; the registry has a convention fallback, but don't rely on it — see
  [Convention paths](#convention-paths-and-why-to-declare-anyway).)
- The node's name in rule paths defaults to the **entity class name** (`HelloWorld`). It must be
  unique across the host and every loaded extension — the naming law's feature-prefixed entity
  names already guarantee this ([00-naming](00-naming.md)). `Node = "..."` overrides it if you must.
- A workspace rule with *applies to whole subtree* (`allowAllChildren`) automatically covers your
  resource — users with broad workspace grants keep working with no admin action.

## Pattern B — parent/child resources

The child declares its parent entity and names the parent-ref property explicitly —
`ParentRefSpec<T>`'s `Spec.ParentId` is **not** a convention path:

```csharp
[AccessControl(Parent = typeof(HelloParent), ParentIdProperty = "Spec.ParentId")]
public class HelloChildrenController : ChildResourceController<HelloChild, HelloParent, HelloChildSpec, HelloChildResult>
```

The parent controller carries the normal Pattern-A declaration. Admins can then grant the parent
with cascade (covers all children) or pick individual children in the editor tree.

The parent entity must itself be declared as a node by some controller — the registry resolves
`Parent = typeof(HelloParent)` through the controller declaration index, not through an attribute
on the entity type. Declaring only the child fails the load:

> `[AccessControl] on …HelloChildrenController: parent entity …HelloParent is not declared as an
> access node by any controller.`

## Pattern C — grouping several resources under one editor branch

An extension shipping many resource types can group them under its own category node, the same
way the platform groups AWS resources under "aws":

```csharp
using Duplo.Ai.Model;
using Duplo.Ai.Model.Attributes;

[AccessCategoryNode("acme", Parent = typeof(Workspace), DisplayName = "Acme Tools")]
public sealed class AcmeCategory : AccessCategory { }
```

then on each controller: `[AccessControl(Parent = typeof(AcmeCategory))]`. Categories are pure
grouping — no id, no endpoints; the `"acme"` node id is written into stored rule paths, so treat
it like a collection name: lowercase and immutable forever. The node **type** name defaults to the
marker class name minus a trailing `Category` (`AcmeCategory` → `Acme`); `NodeType = "..."` overrides.

Categories are transparent for id resolution — the child still stores its reference to the nearest
**entity** ancestor (the workspace), and the registry inserts the category segment when it builds
the path. So a category-grouped controller keeps `ParentIdProperty = "OwnerWorkspaceId"`.

## What you inherit for free

`GenericServiceController<T>` — the base under every `ResourcesController<>` — already carries:

- a property-less `[AccessControl]`, which **attaches the enforcement filter and declares nothing**.
  That is what makes the model fail-safe: a controller cannot be annotated but left unguarded, and
  your derived controller is filtered whether or not it declares a node.
- `[AccessControl(List = true)]` on `GetAll`. Collection reads gate the route ancestors and then AND
  a per-item access predicate **into the Mongo query**, so paging and `totalCount` stay correct
  rather than being filtered after the fact. You get this on your list endpoint for free.

`ResourcesController<>` additionally overrides the verb on lifecycle endpoints whose HTTP method
doesn't match their meaning, so you don't have to:

| Endpoint | Enforced as |
|---|---|
| `POST {id}/deprovision` | `AccessVerbs.Delete` |
| `POST {id}/status`, `POST {id}/results`, reconcile | `AccessVerbs.Put` |

## Named actions — endpoints that need an explicit grant

CRUD verbs cover the inherited endpoints. A custom endpoint that does something a plain
"can edit this resource" grant should NOT imply — restart, console/exec access, credential
minting, applying infrastructure — declares a **named action** instead. The action check *replaces*
the verb check, and `ALL` verbs never grants an action; admins must grant the action id explicitly.

```csharp
[HttpPost("{id}/restart")]
[AccessControl(Action = "acme.restart", Destructive = true,
    ActionName = "Restart the Acme service",
    Description = "Stops and restarts the running service. In-flight requests are dropped.")]
public async Task<IActionResult> Restart(string id, CancellationToken ct = default) { ... }
```

Rules:

- **`Description` is mandatory.** An action with no description on any declaration fails the load:
  *"Action 'acme.restart' has no Description on any declaration — an undocumented action cannot be
  granted responsibly."*
- Action id grammar: `<feature>.<capability>`, lowercase. The prefix groups your actions in the
  permission editor; the id is stored inside customers' permission sets, so it is immutable.
- If one action id gates several endpoints, put `ActionName`/`Description` on exactly one
  declaration and reference the bare `Action = "..."` elsewhere. Two different non-empty
  descriptions for one id fail the load with *"conflicting descriptions on … and …"*.
- `Destructive = true` surfaces a warning affordance in the permission editor. Use it for anything
  that mints credentials, destroys infrastructure, or drops in-flight work.
- Renaming an action id invalidates rules customers already stored. Keep the old id working by
  listing it in `ActionAliases = new[] { "acme.old-id" }`; the registry normalises aliases to the
  canonical id at load. An alias that collides with a real action id, or maps to two different
  ids, fails the load.
- A lifecycle endpoint whose HTTP method doesn't match its meaning uses a **verb override** instead
  of an action — `[AccessControl(Verb = AccessVerbs.Delete)]`. The inherited endpoints above
  already do this.

### Endpoints deliberately outside the model

A type-level lookup that isn't about any one resource — "which engines exist", "what regions are
valid" — has no entity to anchor on. Mark it, with a reason:

```csharp
[HttpGet("engines")]
[NoResourceAccessCheck(Reason = "Type-level catalog read; no resource instance to authorize against.")]
public ActionResult<IReadOnlyList<string>> Engines() => Ok(_svc.Engines);
```

This is documentation and a coverage-report hook, not behavior. `Reason` is required — an empty
one is a smell.

## Anchoring — when the target isn't route `id`

By default the filter reads the target's identifier from the route's `id`. When it lives under a
different key, or identifies a *different* node than this controller's own, say so:

| Property | Use |
|---|---|
| `RouteKey` | The route key carrying the identifier — `"clusterId"`, `"rgId"`. Shorthand ctor: `[AccessControl("clusterId")]`. |
| `AnchorNode` | The node type that key resolves to, when it is **not** this controller's own node. |
| `LookupBy` | `AnchorLookup.Id` (default) or `AnchorLookup.UniqueName` when the key carries a name. |
| `ParentRouteKey` | Required with `UniqueName`: the route key of the parent whose scope makes the name unique. Names are resolved by (name, parent id), never globally. |

Method-level values override class-level ones.

## What the platform does for you

Once the node is declared, the enforcement filter resolves the resource's real position from its
stored refs and cross-checks the route — a caller cannot pair a workspace they can access with a
foreign resource id. Manual `entity.OwnerWorkspaceId != GetWorkspaceIdFromRoute()` checks in
custom endpoints become redundant; keep input validation, drop tenancy checks.

Denials are also distinguished deliberately: **403** when the caller may see the resource but not
perform the verb, **404** when the resource is meant to be invisible to them. Don't collapse the
two in your own endpoints.

## Convention paths, and why to declare anyway

Omitting `ParentIdProperty` makes the registry try the convention paths — `Spec.ResourceGroupId`,
`OwnerWorkspaceId`, `WorkspaceId` — and each is pinned to the node type it may anchor on. Because
`OwnerWorkspaceId` exists on *every* entity, an omitted declaration on a child resource would
silently bind it to the workspace instead of its real parent. The registry refuses rather than
guess:

> `no ParentIdProperty declared, and the convention path 'OwnerWorkspaceId' holds a Workspace id
> while this node's entity anchor is HelloParent. Declare ParentIdProperty explicitly.`

Declare it explicitly and the question never arises.

## Declarations that reject your load

The loader rebuilds and validates the host's access registries over your controllers and
**publishes them before it commits your assembly's ApplicationPart**. So a bad declaration fails
the load atomically: your extension shows `Failed` with the validation message, the partial runtime
is unwound (part removed, child container disposed, ALC unloaded), and the host keeps running
unaffected. Any of these fails:

- `Root = true` — the tree has exactly one root (Workspace); extensions always parent under it.
  (`Root` with a `Parent` is rejected outright.)
- A non-root node with no `Parent` at all.
- An entity that doesn't derive `Entity`.
- Two controllers declaring the same node type name, or a name colliding with an existing host or
  extension node.
- A `Parent` entity that no controller declares as a node.
- A `ParentIdProperty` that doesn't resolve to a string property on your entity, or an omitted one
  where no convention path fits (see above).
- A category chain that doesn't terminate at an entity type, is cyclic, or re-declares an existing
  category with a conflicting `NodeId`.
- An action with no `Description`, conflicting descriptions across declarations, or a colliding
  alias.

On a host restart, a persisted extension that fails these checks is skipped with an
`ExtensionLoadFailed` fault — it never blocks the platform from booting.

## Compatibility and rollout

- Requires a host that ships hierarchical access control (the SDK feed exposes
  `Duplo.Ai.DataManagement.AccessControl.*` and `Duplo.Ai.Model.AccessCategory`). Against an older
  host the attribute fails to compile (`CS0246: AccessControl not found`) — either upgrade the host
  or remove the declaration until it's upgraded. Check with
  `GET /v1/aiservicedesk/extensions/sdk-bundle` if you're unsure what your host serves.
- Adding the declaration to an existing extension is a behavior change for non-admin users:
  broad workspace grants (ALL verbs + subtree cascade — including every permission set migrated
  from the legacy model) keep working automatically; users with narrow grants need the new node
  (and any named actions) granted before they can reach the resource again.
- Adding or changing a declaration is a backend change — bump `manifest.version` before re-loading
  ([06](06-registration.md#reloading-changed-code--bump-manifestversion)).

## Not yet supported

Parenting under a Resource Group or the platform's `aws`/`k8s` categories — those types live in
DevOps assemblies that are not part of the extension SDK feed today. Workspace-parented resources
(optionally grouped under your own category) are the supported shapes.

## Worked examples in this repo

| Sample | Shows |
|---|---|
| [`samples/helloworld`](../../../../samples/helloworld/backend/HelloWorldController.cs) | Pattern A, the minimum declaration |
| [`samples/parent-child`](../../../../samples/parent-child/backend/HelloChildController.cs) | Pattern B, and why `Spec.ParentId` must be explicit |
| [`samples/network-stack`](../../../../samples/network-stack/backend/NetworkStacksController.cs) | Named actions — a non-destructive `plan` and a destructive `apply` alongside inherited CRUD |
