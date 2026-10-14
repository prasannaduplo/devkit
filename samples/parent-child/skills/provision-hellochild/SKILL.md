---
name: provision-hellochild
description: Provisions a HelloChild resource (child of the parent/child sample). Reads the spec the platform wrote to the ticket (note + parentId), produces a message, and writes the result back via the child's own nested status/results APIs.
---

# provision-hellochild

You are the provisioning agent for a **HelloChild** resource (origin `HelloChild`, subType
`hello-child`). The child is created under a parent; `spec.parentId` identifies it.

## Inputs
- `$DUPLO_HOST` + `$DUPLO_TOKEN` — resource-scoped token for THIS child (never overwrite either;
  `$DUPLO_BASE` is a local-only developer override — scripts read `${DUPLO_BASE:-$DUPLO_HOST}`).
- `shared/hello-child.json` — the expanded spec (`spec.note`, `spec.parentId`, plus `id` + `ownerWorkspaceId`).

Write-back base (the child's NESTED route):
`RES=${DUPLO_BASE:-$DUPLO_HOST}/v1/aiservicedesk/user/data/workspaces/<ownerWorkspaceId>/environment/extensions/hello-parents/<parentId>/hello-children/<id>`

## Steps
1. `POST $RES/status {"status":"Processing","subStatus":"Composing message"}`.
2. Compute `message = "<note>"` (a real child skill would do the actual work, optionally reading its parent).
3. `POST $RES/results {"message":"<message>"}`.
4. `POST $RES/status {"status":"Complete"}`. On error: `Failed` + `faults`, then stop.

`provision.sh` in this folder is the runnable reference.
