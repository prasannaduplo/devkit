---
name: provision-rdsupgrade
description: Provisions an RdsUpgrade resource — upgrades an RDS instance's major engine version via an AWS Blue/Green Deployment (precheck, snapshot, parameter group clone, Blue/Green create + delete-guard, validate, switchover, post-verify, cleanup).
---

# provision-rdsupgrade — AWS RDS Blue/Green upgrade orchestration

You are the **provisioning agent** for an **RDS Upgrade** resource (origin `RdsUpgrade`, subType
`rds-upgrade`). This is **agent-based provisioning** (`ProvisioningMode.HelpdeskAgent`) — not a Worker.
That choice matters: a prior Worker-mode version of this extension had its `ApplyAsync` tick cancelled by
the platform after ~97 seconds (confirmed via CloudTrail), far short of the 10-20+ minutes a real AWS
Blue/Green deployment needs. Tickets don't have that constraint, which is exactly why this now runs here.

## Run the deterministic script
`provision.sh` (next to this SKILL.md) does the entire flow — precheck through cleanup, posting
`status`/`results` after every phase so the UI's phase tracker updates live. Invoke it from the ticket
workdir (this skill is mounted under `.claude/skills/`, so the path is NOT `skills/…`):

```bash
bash .claude/skills/provision-rdsupgrade/provision.sh
```

Prefer running it as-is. Only deviate (running steps by hand) if the script errors in a way that needs
judgment — e.g. deciding whether a transient AWS throttling error is worth a manual retry.

## Inputs

- `$DUPLO_BASE` (fall back to `$DUPLO_HOST`) + `$DUPLO_TOKEN` — resource-scoped, valid for this
  resource's `…/{id}/status` and `…/{id}/results` only.
- `shared/rds-upgrade.json` — the expanded spec: `id`, `ownerWorkspaceId`, and `spec.{dbInstanceIdentifier,
  region, targetEngineVersion, targetInstanceClass, targetParameterGroupName, switchoverTimeoutMinutes}`.
- The resource's AWS scope's credentials, materialized to `./.aws/credentials` (+ `.aws/config`) as a
  named profile — the script resolves the profile name itself (first `[profile]` section) rather than
  needing it passed in, same convention as `extensions/terraform/skills/.../scripts/aws-env.sh`.

## Known gotchas (learned the hard way during testing, 2026-10-07)

- **AWS Blue/Green does not support Secrets-Manager-managed master passwords.** If
  `create-blue-green-deployment` fails with `SourceDatabaseNotSupportedFault: Databases using Secrets
  Manager are not currently supported`, the source instance needs `ManageMasterUserPassword` disabled
  (via `modify-db-instance` with an explicit `--master-user-password`) before retrying. The script does
  **not** auto-fix this — it's a precondition on the source instance, not something to silently work
  around during provisioning.
- **`duplomaster` is the IAM role the delete-guard targets** (`iam:PutRolePolicy`/`DeleteRolePolicy`,
  scoped to the green instance's ARN) — this protects against Duplo's own tenant reconciler deleting the
  AWS-created green instance mid-creation before it's recognized as managed. Confirmed this account's
  `duplomaster` role has self-modify IAM permission; a different account's `duplomaster` might not, in
  which case this step would need the scope's credential pointed at a role that does.
- **Valid Blue/Green upgrade targets are not "any version ≥ current."** AWS only allows specific target
  versions per source version (check `aws rds describe-db-engine-versions --engine-version <source>
  --query 'DBEngineVersions[0].ValidUpgradeTarget[].EngineVersion'` before picking `targetEngineVersion`
  if it wasn't already validated at resource-creation time).

## On failure
The script's own `trap ... ERR` handles this: appends a `Failed` step, best-effort detaches the
delete-guard and deletes an unfinished Blue/Green deployment (mirroring what a human would do by hand),
posts `results` with `phase: "Failed"` + `errorMessage`, then posts `status: Failed` with `faults`. You
don't need to do this manually unless the script itself can't run (e.g. missing AWS credentials) — in
that case post `status: Failed` with a clear fault message yourself.

## Notes
- Status and results are two separate APIs — never fold the result into a status payload.
- The result body IS the typed `RdsUpgradeResult` object (`backend/RdsUpgrade.cs`); the extension's FE
  renders `result.phase`/`result.stepHistory` as the visual phase tracker.
- See [reference/01-architecture.md](../../../../.claude/skills/duplo-extension-dev/reference/01-architecture.md)
  for the agent-provisioning loop, and
  [reference/07-scope-credentials.md](../../../../.claude/skills/duplo-extension-dev/reference/07-scope-credentials.md)
  for how the AWS scope's credentials land on disk.
