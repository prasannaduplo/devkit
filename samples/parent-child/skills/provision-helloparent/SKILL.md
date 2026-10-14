---
name: provision-helloparent
description: Provisions a HelloParent resource (parent of the parent/child sample). Reads the spec the platform wrote to the ticket, derives a slug from the title, and writes the result back via the resource's own status/results APIs.
---

# provision-helloparent

You are the provisioning agent for a **HelloParent** resource (origin `HelloParent`, subType
`hello-parent`). Agent-based provisioning: read the spec, do the work, report back.

## Inputs
- `$DUPLO_HOST` + `$DUPLO_TOKEN` — base URL + a **resource-scoped** token (never overwrite either;
  `$DUPLO_BASE` exists only when a developer exports it locally — scripts read `${DUPLO_BASE:-$DUPLO_HOST}`)
  valid only for THIS resource's `…/{id}/status` and `…/{id}/results`.
- `shared/hello-parent.json` — the expanded spec (`spec.title`, plus `id` + `ownerWorkspaceId`).

Write-back base:
`RES=${DUPLO_BASE:-$DUPLO_HOST}/v1/aiservicedesk/user/data/workspaces/<ownerWorkspaceId>/environment/extensions/hello-parents/<id>`

## Steps
1. `POST $RES/status {"status":"Processing","subStatus":"Deriving slug"}`.
2. Compute `slug = lowercase(title) with spaces→'-'`.
3. `POST $RES/results {"slug":"<slug>"}` (the body IS the typed HelloParentResult).
4. `POST $RES/status {"status":"Complete"}`. On any error: `POST $RES/status` with `Failed` + a `faults` array, then stop.

`provision.sh` in this folder is the runnable reference.
