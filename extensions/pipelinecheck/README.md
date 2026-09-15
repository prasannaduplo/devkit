# Pipeline Check — canonical typed extension

This is the **worked reference** the `duplo-extension-dev` skill copies and adapts. It is the smallest
complete, buildable, loadable DuploCloud extension that behaves as a **first-class resource**: a real C#
`ResourcesController` + service + entity (its own Mongo collection + REST route), an Angular 22
Native-Federation remote (list/add/view), and a provisioning skill. The upload endpoint compiles
nothing — it loads the **pre-built DLL** into a collectible AssemblyLoadContext + per-extension DI child
container and registers the new controller's routes **live** (no host restart), exactly like a
built-in resource (Namespace, NetworkBaseline).

```
backend/    typed C# — Spec/Result/Resource/Hooks/Service (SDK base classes) + ResourcesController
frontend/   Angular 22 Native-Federation remote (list/add/view) using the platform UI lib @duplocloud-internal/ng-common-lib
skills/     provision-pipelinecheck — reads firstName+lastName, writes fullName back as the result
resources-frontend-templates/  declarative Result view-template (see reference/09-result-templates.md)
manifest.json  ties it together: backend block + typed resource + skill + frontend remote/menu/route
```

The example resource takes `firstName` + `lastName` and produces `fullName`, persisted in its own
`extension_pipelinechecks` collection and served at `…/environment/extensions/pipelinechecks`.

## What it demonstrates

- A resource type contributed by a hot-loaded extension DLL with **no host changes**: its own controller
  becomes routable at `…/environment/extensions/pipelinechecks`, its service runs the standard provisioning
  lifecycle, and FaultDetection reconciles it — identical to a first-party resource.
- The skill → **status** → **result** loop (the two write-back APIs are separate), posted to the
  resource's OWN route. Spec fields are typed properties under `spec`; the result is the typed result
  object.
- A per-extension Native-Federation remote that shares the host's Angular 22 / RxJS singletons, reaches
  host services via the `REMOTE_DuploHttpClient` + `REMOTE_UserSession` string DI tokens, and builds its
  UI from the platform library `@duplocloud-internal/ng-common-lib` (searchable-datatable, forms,
  view-with-sidecards, and the declarative result renderer) so it looks native.

## Build + package + load

```bash
# 1. SDK feed — pin the extension to the host's exact SDK version
SDK_VER=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$DUPLO_BASE/v1/aiservicedesk/extensions/sdk-version" | jq -r .version)
curl -fsS -H "Authorization: Bearer $TOKEN" "$DUPLO_BASE/v1/aiservicedesk/extensions/sdk-bundle" -o /tmp/sdk.zip
unzip -o /tmp/sdk.zip -d backend/sdk-packages

# 2. Backend DLL. The SDK is compile-only, but publish still copies its whole transitive closure
#    (Mongo/AWS/AspNetCore + native runtimes/) into dist/backend — the host already has all of it, so only
#    this extension's own dll belongs in the bundle (step 4). Or just run scripts/build-extension.sh, which
#    trims automatically.
( cd backend && dotnet publish Duplo.Extension.PipelineCheck.csproj -c Release -o ../dist/backend -p:DuploSdkVersion="$SDK_VER" )

# 3. Frontend remote — uses the platform UI lib @duplocloud-internal/ng-common-lib from the vendored
#    tarball (frontend/vendor/*.tgz, referenced via file: in package.json), so NO token is needed.
#    Plain `npm install` — the one Angular 22 peer conflict (ngx-toastr) is resolved by the "overrides"
#    block in package.json, so the `--legacy-peer-deps` escape hatch is neither needed nor allowed.
#    The build writes frontend/dist/remoteEntry.json + sibling ESM chunks (no dist/browser/, no index.html).
( cd frontend && npm install && npm run build )

# 4. Assemble the bundle: manifest.json + backend/ (your DLL only) + fe/ + skills/ + templates, then zip
rm -rf pkg; mkdir -p pkg/backend pkg/fe pkg/skills
cp manifest.json pkg/ ; cp dist/backend/Duplo.Extension.*.dll pkg/backend/ ; cp -r frontend/dist/* pkg/fe/ ; cp -r skills/* pkg/skills/
[ -d resources-frontend-templates ] && cp -r resources-frontend-templates pkg/resources-frontend-templates
rm -f extension.zip   # zip updates in place — drop the stale archive first so the bundle shrinks
( cd pkg && zip -r ../extension.zip . )

# 5. Upload the bundle — the studio unpacks + hot-loads the DLL
curl -fsS -X POST "$DUPLO_BASE/v1/aiservicedesk/user/data/workspaces/$WS/environment/extensions/$ID/load-bundle" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" --data-binary @extension.zip
```

See the skill entry point `../../SKILL.md` for the full build+load flow (in-platform and local), and the
framework docs in `../../reference/` — `01-architecture.md`, `02-authoring-guide.md`, `03-base-classes.md`,
`04-hooks.md`, `05-custom-actions.md`, `06-registration.md`.

## Adapt for a new resource

Rename `PipelineCheck*` → your resource across `backend/` (classes, `[BsonCollection]`, controller
`[Route]`, `GetTicketOriginType`/`SubType`), edit the spec/result fields, update the FE service
(`SUB_TYPE`, REST segment, origin-context `type=`), the skill, and `manifest.json` (ids, type names,
`backend.entryAssembly`, originType/subType, restSegment, menu, route). Keep `archetype: "typed"` (NOT
`skill-based`) so the loader takes the DLL path. Future archetype templates will live beside this one.
