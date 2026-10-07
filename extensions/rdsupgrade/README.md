# RDS Upgrade extension

Upgrades an RDS instance across a major engine version using an AWS Blue/Green Deployment instead
of an in-place upgrade, so there's no multi-minute downtime window. Give it a source instance and
a target engine version; it snapshots, stands up a parallel "green" copy on the new version,
validates it, cuts traffic over, and cleans up the old side — all visible step by step in the
portal. Built from a real, previously hand-run shell-script process (Payfinia's production MySQL
upgrades), turned into a typed, self-service DuploCloud extension.

Supported engines: **MySQL, MariaDB, PostgreSQL, Aurora MySQL, Aurora PostgreSQL** — the same list
AWS itself supports for Blue/Green, not narrowed to one customer. No hardcoded business logic —
generic, works against any AWS account/scope with an eligible instance.

This file covers both **how it's built and what broke along the way** (for engineers) and **how to
test it** (for QA) — one document, since both audiences need the same gotchas.

---

## Part 1 — Architecture

### Shape

Typed DuploCloud resource (`originType: RdsUpgrade`, `subType: rds-upgrade`), **Agent-mode**
provisioning — a HelpDesk ticket runs `skills/provision-rdsupgrade/provision.sh` end to end,
posting progress to the resource's `status`/`results` APIs after every phase. The C# backend
(`backend/RdsUpgrade.cs`, `RdsUpgradeController.cs`) is just the typed Spec/Result/entity/REST
scaffold — it contains **no AWS SDK code at all**; all AWS orchestration happens via the AWS CLI
inside the provisioning script. See "Why Agent mode, not Worker mode" below for why.

### Phase sequence

```
Prechecking → Snapshotting → CreatingParamGroup → CreatingBlueGreen → ValidatingGreen
  → CuttingOver → PostVerify → CleaningUp → Completed
```
`Failed` is reachable from any phase before `Completed`. Each phase's completion is persisted via
`POST .../results` immediately, so the UI's phase tracker reflects live progress rather than
jumping from "Requested" straight to a final state.

### The delete-guard

While the "green" instance exists mid-upgrade, Duplo's own tenant reconciler can see it as an
untracked resource (it isn't recognized as managed yet) and try to delete it. The script attaches
a scoped IAM Deny policy — `rds:DeleteDBInstance`/`rds:DeleteDBCluster` on exactly the green
instance's ARN, nothing broader — to the role the AWS scope assumes (by convention, `duplomaster`),
right after the Blue/Green deployment is created, and detaches it at cleanup (or on any failure,
best-effort, in the script's error trap).

### Why Agent mode, not Worker mode

v1 was originally built as a Worker-mode resource (`ResourceWorkerBase.ApplyAsync` doing the whole
flow in one background call). **This does not work**: the host platform cancels a Worker's
`ApplyAsync` tick after approximately **97 seconds**, confirmed via CloudTrail —

| Attempt | `CreateBlueGreenDeployment` | Platform's own `DeleteBlueGreenDeployment` | Elapsed |
|---|---|---|---|
| 1 | 05:31:04 | 05:32:41 | 97s |
| 2 | 05:57:07 | 05:58:44 | 97s |
| 3 | 06:09:46 | 06:11:22 | 96s |

Every deployment was still `PROVISIONING` (AWS Blue/Green typically needs 10–20 minutes) when the
platform tore it down with `deleteTarget=true`. This is **not** the extension's own timeout (its
internal deadlines were 30–60 minutes) — it's the host's background-worker dispatcher imposing an
external cancellation on the `CancellationToken` passed into `ApplyAsync`, well short of what this
operation needs.

Two research passes confirmed there's no easy fix on the Worker side:
- `ResourceWorkerBase`'s actual source isn't present in either this repo or the `duplo` backend
  monorepo — it lives in a separate, closed "AI Studio backend" not checked out anywhere
  accessible. No documented config knob (`DefaultTickInterval`, `MaxRowsPerTick`, `DriftCadence`,
  `TerminalRetryThreshold` are the only tunables mentioned anywhere) controls this duration.
- `EksUpgradeBase` (the platform's EKS-upgrade orchestrator, which handles even longer 20–40
  minute operations) turned out to be built on a **completely different, older subsystem**
  (`AbstractWorker`/`NodeStateDriver`, a legacy polling-thread engine with its own 20-minute budget
  and genuine resume-every-120-seconds semantics) — not `ResourceWorkerBase` at all. So "EKS
  upgrades work fine" wasn't evidence Worker-mode extensions can span long operations; it was
  evidence a different, older part of the platform can.

HelpDesk tickets (Agent mode), by contrast, had already tolerated many-minutes-long operations
repeatedly in direct testing (RDS instance creation, AWS CLI diagnostic sessions) with no cutoff —
and Agent-mode's per-skill provisioning timeout is an explicit, configurable `manifest.json` field
(`skillMappings[].timeout.provision`, currently set to 3600s) rather than a hidden platform
constant. **Note**: the loaded manifest's parsed value for this field has shown as `null` in
`GET /admin/extensions` even after setting it — whether it's actually enforced hasn't been
independently confirmed, but it hasn't mattered in practice since real runs (26+ minutes) have
completed without any cutoff.

Rewriting from Worker to Agent mode meant: delete `RdsUpgradeWorker.cs` and `RdsUpgradeExtension.cs`
entirely, remove the `AWSSDK.RDS`/`AWSSDK.IdentityManagement` package references (no longer
needed — see below), and add `skills/provision-rdsupgrade/{SKILL.md,provision.sh}` plus a
`skillMappings` entry in `manifest.json`.

---

## Part 2 — Build history: issues found and fixed

In the order they were hit. Several of these look like bugs in retrospect but are real AWS/platform
behavior worth knowing before "fixing" something that isn't broken.

### 1. NuGet version conflicts (when this was still Worker-mode C#)
- **First conflict**: `AWSSDK.RDS Version="3.7.400.0"` required `AWSSDK.Core >= 3.7.400 && <
  4.0.0`, but the SDK's own transitive closure (via `AWSSDK.CloudWatchLogs`) required
  `AWSSDK.Core >= 4.0.102.1`. Fixed by floating both `AWSSDK.RDS` and `AWSSDK.IdentityManagement`
  to `Version="4.*"`.
- **Second conflict**: after floating to `4.*`, an explicit `AWSSDK.Core Version="4.0.102.1"` pin
  was added defensively — this then conflicted as a *downgrade* against the `4.0.102.6+` that the
  resolved `AWSSDK.RDS 4.0.105.3`/`AWSSDK.IdentityManagement 4.0.103.6` actually needed. Fixed by
  removing the explicit `AWSSDK.Core` reference and letting NuGet resolve it transitively.
- **Now moot**: the Agent-mode rewrite removed all AWS SDK package references from the C# project
  entirely (AWS calls happen via the CLI in the provisioning script instead), so this whole class
  of conflict can't recur for this extension.

### 2. Frontend naming validation failure
The frontend was scaffolded from a copy of the `pipelinecheck` sample; its service still declared
`REST_SEGMENT = 'extensions/pipelinechecks'` against a manifest `restSegment` of
`'extensions/rdsupgrades'`. The build script's naming gate caught the mismatch. Fixed by renaming
every `pipeline-check`-derived identifier across the frontend files.

### 3. AWS client resolution outside the `try` block
The original `ApplyAsync` called `factory.CreateAwsClientAsync(...)` *before* the `try` block. A
scope-resolution failure (e.g. no AWS scope attached) then threw before any step was recorded,
leaving `Result.Phase` stuck at `"Requested"` with an empty `StepHistory` even though the resource
showed `Failed` — a confusing, uninformative failure. Fixed by moving client resolution inside
`try`, declaring the client variable (`AmazonRDSClient? rds = null`) before the `try` so a
best-effort rollback in `catch` could still reach it, and disposing in `finally`. (This class of
bug doesn't apply to the current Agent-mode script, which has no such resolution step, but the
same principle — don't let setup failures skip step-recording — carried into `provision.sh`'s
error trap.)

### 4. `duplo-jit` doesn't work against the AI Studio host
`duplo-jit aws --admin --host <AI Studio host> --interactive` returns `404` on
`v3/admin/aws/jitAccess/admin`. That endpoint only exists on classic DuploCloud SaaS platforms
(the full infrastructure-tenant product); the AI HelpDesk Studio product this dev-kit targets
doesn't implement it. There's no JIT-AWS-console-access path for this host at all — AWS access for
testing has to go through a Scope attached to the workspace instead (or, for ad hoc shell access,
whatever credential source you'd normally use outside Duplo).

### 5. IAM role trust failure on one scope's credential
Using the `test21-admin-iam-role` scope (assumes
`arn:aws:iam::<account>:role/DuploCloud-AWS-Admin-duploinfra-sy25011601`) failed with: *"User:
arn:aws:sts::<account>:assumed-role/duploservices-dev-helpdesk/... is not authorized to perform:
sts:AssumeRole on resource: ...DuploCloud-AWS-Admin-duploinfra-sy25011601."* That role's trust
policy doesn't include this particular HelpDesk host's agent identity. Switching to the
`aws-test21-admin` scope (assumes `duplomaster` instead) worked — `duplomaster` is the broadly-
trusted role Duplo's own tooling uses across the board. If you hit this, it's a trust-policy
mismatch on that specific role, not a bug in the extension — try a different scope/credential
pointed at a role with broader trust.

### 6. AWS Blue/Green rejects Secrets-Manager-managed passwords
`CreateBlueGreenDeployment` fails immediately with `SourceDatabaseNotSupportedFault: Databases
using Secrets Manager are not currently supported for Blue Green Deployments` if the source
instance has `ManageMasterUserPassword` enabled. This is a real, undocumented-until-you-hit-it AWS
limitation, not an extension bug. Fix: disable it on the source
(`aws rds modify-db-instance --no-manage-master-user-password --master-user-password <value>`)
before creating the upgrade resource.

### 7. Non-idempotent retries created duplicate/orphaned-looking AWS resources
Early Worker-mode retries re-ran the entire sequence from scratch on every attempt (no memory of
prior progress), which (a) created a fresh pre-upgrade snapshot on every retry, and (b) once one
retry got further than the others (created a real Blue/Green deployment, then failed at a later
step — this was before the ~97s root cause was understood), the next retry's Prechecking saw that
still-active deployment and rejected it as "already has an active Blue/Green deployment," while the
worker's own catch-block rollback correctly tore down the half-finished deployment
(`DeleteBlueGreenDeployment ... --delete-target true`). What looked like orphaned resources
piling up in the AWS console was actually the rollback working as designed — just repeatedly,
because nothing was idempotent across attempts.

Fixed (in the current Agent-mode script) by seeding `SNAPSHOT_ID`, `PARAM_GROUP_NAME`,
`BG_DEPLOYMENT_ID`, `GREEN_INSTANCE_ID`, `GREEN_ENDPOINT`, and `stepHistory` from the resource's
own previously-persisted result at the top of every invocation, and excluding the script's own
tracked Blue/Green deployment ID from the Prechecking "active deployment" conflict check — a second
invocation resumes instead of colliding with its own prior work.

### 8. `jq` bug: empty message broke step recording
`add_step()`'s JSON construction used `message:($m|select(length>0))` to omit the `message` field
when empty. `select(length>0)` on an empty string produces **zero output**, which makes the whole
object-construction pipeline produce zero outputs — so the "step" JSON came back as an empty
string, and the next `jq --argjson` call failed with `invalid JSON text passed to --argjson`. This
surfaced as a generic, useless platform-level error: `Unexpected failure in phase Prechecking
(exit 2)` with no steps recorded at all, on the very first `add_step` call (which has no message).
Fixed by always including `message` (even as `""`) instead of trying to conditionally omit it.

### 9. A resumed run's `/results` POST silently wiped prior progress
Each `POST .../results` call replaces the whole Result document (not a merge). Combined with issue
#7's non-idempotency, a second invocation that failed immediately at Prechecking would post a
*thin* failure result — overwriting a first attempt's real progress (snapshot ID, Blue/Green
deployment ID, step history) with almost nothing. The fix for #7 (seeding state from the persisted
result before touching anything) also fixes this, since every `post_results` call after that now
includes the carried-forward fields rather than blanks.

### 10. The resumability fix's own `GET` call wasn't authorized
The straightforward fix for #7/#9 — `GET` the resource to read its current result before deciding
what to resume — doesn't work: **a provisioning ticket's token is scoped only to
`.../{id}/status` and `.../{id}/results`**, not a generic `GET` on the resource itself. The bare
`GET $RES` call returned 401/403, which `curl -f` turns into exit code `22`, surfacing again as the
same generic `Unexpected failure in phase Prechecking (exit 22)` with zero steps recorded — this
time on *every* run, not just resumed ones, since the broken call was unconditional. Fixed by
reading from `GET $RES/results` instead (within the token's authorized scope), and making the
entire resume-seed step non-fatal regardless of outcome — a brand-new resource legitimately has
nothing to resume from yet, which is a normal case, not an error.

### 11. `--delete-target false` is invalid AWS CLI syntax
`DeleteTarget` is a boolean API parameter, but the AWS CLI represents booleans as **toggle flags**:
`--delete-target` (true) / `--no-delete-target` (false) — not `--flag <value>`. The cleanup step's
`aws rds delete-blue-green-deployment ... --delete-target false` call almost certainly errored on
invalid syntax, and the error was swallowed by `2>&1 >/dev/null || true`, so a successful upgrade
would still leave the (by-then-harmless, but cluttering) Blue/Green deployment object behind in the
AWS console even though the resource showed `Completed` with the `CleaningUp` step marked `OK`.
Fixed to `--no-delete-target`, and the cleanup step no longer swallows errors silently — a failed
cleanup command now shows up as a `Warning` step with AWS's real error message instead of a false
`OK`.

---

## Part 3 — Current state

Two real, complete, end-to-end upgrades against a live (disposable, sandboxed) AWS account, chained
on the same instance:

| Run | Path | Blue/Green deployment | Result |
|---|---|---|---|
| `run5` | `5.7.44-rds.20250213` → `8.0.46-rds.20260908` | `bgd-oobswo1egc6b4mnm` | `Complete`, old instance (`rdsupgrade-fixture-mysql2-old1`) removed at cleanup |
| `run6` | `8.0.46-rds.20260908` → `8.4.3` | `bgd-m1s7sm3twuppauir` | `Complete` in 26 min, snapshot `rdsupgrade-fixture-mysql2-preupgrade-20261007115350` |

Both landed on the correct target engine version (verified by the script's own `PostVerify` step,
which fails the whole run if the final version doesn't match the target), with the old pre-upgrade
instance and the Blue/Green deployment object both cleaned up automatically.

### Known limitations (v1 → v2)
- **No approval gate before cutover or cleanup.** Runs single-shot once triggered, same as the
  original manual script. A pause-for-human-approval step before switchover (and again before
  final cleanup) is the main v2 item — likely modeled on the platform's `EksUpgradeBase`
  chain-of-responsibility + persisted-state pattern once that's better understood.
- **No live AWS picker.** The Add form has no scope picker at all — `ScopeIds` is currently
  **hardcoded** in `frontend/src/app/add/add-rds-upgrade.component.ts` to one specific scope as a
  stopgap (see the comment there). Source instance, region, and target version are typed in, not
  selected from a live AWS-backed dropdown.
- **Doesn't auto-pick the target version.** By design, not a gap: `TargetEngineVersion` is always
  user-specified. Auto-selecting "latest" on a database this important felt like the wrong default.

---

## Part 4 — Testing guide

This part assumes you can click through the DuploCloud portal and read AWS console output,
nothing more.

### Before you start
You need:
1. A workspace with an **AWS scope** attached, pointing at the account that owns the instance
   you're testing against (check the workspace's **Cloud** scopes list).
2. That scope's credential needs real RDS permissions (`DescribeDBInstances`, `CreateDBSnapshot`,
   `CreateBlueGreenDeployment`, `SwitchoverBlueGreenDeployment`, `DeleteBlueGreenDeployment`,
   `DeleteDBInstance`, `CopyDBParameterGroup`) plus `iam:PutRolePolicy`/`iam:DeleteRolePolicy` on
   whatever role it assumes (see "The delete-guard" above) — if that role's self-IAM permission is
   missing, or its trust policy doesn't include this host's agent identity (see build-history
   issue #5), the run will fail at a specific, identifiable step, not silently.
3. A disposable test RDS instance — **do not point this at anything real.**

### Setting up a test instance
- **Fastest**: open a HelpDesk ticket on the workspace, select your AWS scope, and ask the agent to
  create a small RDS instance on an old engine version — e.g. *"Create a db.t3.micro MySQL
  instance, identifier test-rdsupgrade-01, oldest engine version still creatable, 20GB storage,
  default VPC, security group allowing 3306 from the VPC CIDR only, set an explicit master
  password directly (do not enable manage_master_user_password)."* That last clause matters — see
  build-history issue #6.
- **Repeatable/scripted**: a standalone Terraform fixture lives at
  `extensions/rdsupgrade/test-fixture/terraform/` in this repo (needs real AWS credentials in your
  own shell, not routed through Duplo — see its own `README.md`).

Before picking a target version, check what's actually valid from your instance's current version
— AWS only allows specific upgrade paths per source version, not "anything newer":
```bash
aws rds describe-db-engine-versions --engine mysql --engine-version <current-version> \
  --query 'DBEngineVersions[0].ValidUpgradeTarget[].EngineVersion' --output table
```

### Creating an upgrade resource
**DevOps → RDS Upgrade → Create**:

| Field | What to put |
|---|---|
| Name | Anything — the resource's display name |
| Source RDS Instance Identifier | Your test instance's exact identifier |
| AWS Region | The region the instance is actually in |
| Target Engine Version | A version confirmed valid above — exact string, e.g. `8.0.46-rds.20260908` |
| Target Instance Class | Leave blank to keep the source's class |
| Target Parameter Group | Leave blank to clone the source's custom group automatically |
| Switchover Timeout (minutes) | Default (5) is fine for a small test instance |

There's no scope picker (see "Known limitations" above) — if you need it pointed at a different
scope/account, ask eng rather than trying to change it yourself.

### What to expect while it runs
Creating the resource opens a HelpDesk ticket — expected, not a sign something broke. The Result
panel shows a 9-step phase tracker that updates live as each phase finishes. While a step is
actively waiting on AWS, the line just below the step count shows the real AWS-side status, e.g.
`Blue/Green: PROVISIONING | Green instance: creating`.

**Typical timing**: 15–30 minutes end to end for a small `db.t3.micro` test instance — AWS's own
pace for provisioning the green side and the snapshot, not something the extension controls.

### What success looks like
- **Status: Complete**, **Phase: Completed**, all 9 stepper nodes green.
- **Final Endpoint** populated, same hostname as the original instance (Blue/Green swaps what's
  behind the identifier, the identifier itself doesn't change).
- **Old Instance (removed at cleanup)** shows an identifier like `<name>-old1`, struck through —
  confirm it no longer exists in the AWS console.
- No leftover Blue/Green deployment object in the AWS console.

### What a clean failure looks like (and why it's fine to report)
**Status: Failed** with the exact phase it stopped at, AWS's own error message, and the full step
history up to that point. This is the extension **working correctly** — designed to fail fast and
roll back rather than leave something half-done. Report failures with the error message and the
phase; don't assume it's expected unless eng confirms it against the known gotchas below.

### Known gotchas — check these before filing a bug
- **"Databases using Secrets Manager are not currently supported for Blue Green Deployments."**
  See build-history issue #6 — disable `manage_master_user_password` on the source first.
- **"already has an active Blue/Green deployment."** A prior attempt left a live deployment behind
  (see issue #7). Check the AWS console for a dangling `<identifier>-bg` deployment; delete it
  (`--no-delete-target` keeps the paired instance) if it's not from a run you're still waiting on.
- **Target version rejected even though it's "newer."** AWS only supports specific upgrade paths —
  always check `describe-db-engine-versions` first (above).

### Re-testing / cleaning up
Cleanup removes the pre-upgrade instance and the Blue/Green deployment object automatically on
success. To test the same upgrade path again from scratch, use a fresh test instance rather than
reusing an already-upgraded one — though re-upgrading the same instance again (continuing from
wherever the last run left it) is also a valid test.

If you used the standalone Terraform fixture, `terraform destroy` tears it down completely.

### Reporting issues
Include: the resource's Status/Phase, the exact error message from the Result panel, the run
(resource name), and roughly when it ran — enough for eng to pull the matching ticket transcript.
