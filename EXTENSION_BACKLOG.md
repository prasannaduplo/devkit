# Extension Backlog

Trackable backlog of DuploCloud devkit extensions derivable from Prasanna's past customer automation.
Owner: `prasannaduplo`. Generated 2026-08-17 against this repo's architecture
([docs/architecture.md](docs/architecture.md), [.claude/skills/duplo-extension-dev/SKILL.md](.claude/skills/duplo-extension-dev/SKILL.md)).
Updated 2026-09-15 with a folder sweep of three checkouts (see [2026-09-15 sweep](#2026-09-15-sweep-findings)
below), a second same-day sweep of the master staging area `~/Documents/ai/claude-workspace` plus
`~/Documents/workspace` and `~/Documents/anjuna` (see [session 2 sweep](#2026-09-15-session-2-claude-workspace--workspace--anjuna-sweep)),
and a **Classification** column (`generic` vs `customer-specific`, see
[Generic vs customer-specific split](#generic-vs-customer-specific-split)). Machine-readable mirror of every row:
[extensions.json](extensions.json) — update both together.

⚠️ **Two live-looking secrets were found during the session-2 sweep and are NOT reproduced here** — see
[Security flags](#security-flags-from-the-session-2-sweep) at the end of that section. Rotate/scrub them; this repo
only records where they were found, not their values.

## How to read this

- **Target extension type** — one of the four provisioning modes this repo supports (see
  [reference/01-architecture.md](.claude/skills/duplo-extension-dev/reference/01-architecture.md) and the SKILL.md
  decision table):
  - **Agent** — LLM-driven, multi-step, open-ended reasoning (a mapped skill runs in the provisioning ticket).
  - **Worker** — deterministic background job: pure compute or reconcile/apply-with-retry, no LLM. Gets scope
    credentials directly via `IScopeClientFactory` / `IScopeCredentials` in C#.
  - **Passthrough** — one external object created/updated/deleted synchronously, no agent, no loop.
  - **No-provision** — observe-only or provision-on-demand-later; nothing fires on save.
- **Scope(s) needed** — the credential category the extension reads at provisioning: `aws`, `azure`, `kubernetes`
  (eks/gke/aks), `github`, `gitlab`, `gcp`, or generic **`other`** (custom HTTP API via `other_scopes/*.json` —
  supported by the framework, but this dev-kit ships no worked sample of it, only the pattern in
  [reference/07-scope-credentials.md](.claude/skills/duplo-extension-dev/reference/07-scope-credentials.md)).
- **Effort tier** — `reuse-ready` (working code/tests, close to the extension shape already), `needs build-out`
  (real artifacts exist but need meaningful engineering to fit the resource lifecycle), `greenfield` (notes/asks
  only, no working code yet).
- **Status** — edit as you go: `Not started` → `In progress` → `Built` → `Shipped`.
- **Classification** — `generic` (the mechanism has no hardcoded business logic for one customer; swap config/credentials
  and it works anywhere with the same scope — higher leverage, sellable across the base) vs `customer-specific`
  (hardcoded to one customer's app names, tenant layout, or business process — still worth building, but the win is
  local to that account). Judgment call, not a strict test; see [the split](#generic-vs-customer-specific-split).

Ranked within each tier by (a) closeness of the existing artifact to a shipped extension and (b) fit with this
repo's supported types/scopes. Rows flagged **NEW GROUND** need something this dev-kit doesn't have a sample for
yet (a custom `other`-scope integration, or a remote-execution channel onto a Windows guest OS that no sample
covers).

## 🏆 Top strategic priorities: generic 3rd-party product extensions (2026-09-15)

You flagged these three as the highest-leverage candidates in the whole backlog: each one implements, upgrades, or
manages a well-known 3rd-party enterprise product *through DuploCloud*, with **zero customer-specific business
logic** — the same extension sells to any customer running that product, not just the one it was built at. This is
a stronger bar than plain `generic` classification (see [the split](#generic-vs-customer-specific-split)), which
just means "no hardcoded business logic" — a 3rd-party product extension additionally has a recognizable commercial
product name attached, making it a pitchable capability on its own.

1. **Anjuna Confidential Computing** — implementation (#21), upgrades (#22), and cert/resource management (#35).
   All three already in the backlog; #35 and #22 both confirmed with real working code (#22 resolved in the
   session-2 sweep — see its row).
2. **IBM MQ Native HA** (#49, NEW) — full implementation/upgrade/management lifecycle. Confirmed with real,
   mature Infrastructure-as-Code at `payfinia-ibmmq/` (outside the three folders swept for this update — found via
   a follow-up grep across `~/Documents/customers/`): a v4.0 Terraform+Kubernetes generator with 95% automation,
   covering install, cross-VPC networking config, monitoring/alerting, backup, and failover testing. See #49's row.
   A related compliance gap surfaced in session 2: #51, IBM License Service, not yet deployed.
3. **IBM MQ Connect:Direct** (#50) — flagged directly by you from hands-on implementation experience. The
   session-2 sweep of `~/Documents/ai/claude-workspace` found real material: a 12-risk scoping document, a
   manual reference install guide, and the actual IBM installer binaries — see #50's row (moved from greenfield to
   needs-build-out).

Recommendation: since Anjuna already has the implementation/upgrade/management split modeled (#21/#22/#35), apply
the same three-way split to IBM MQ Native HA once #49 goes to build-out, rather than shipping one monolithic
extension — matches how the rest of the backlog is shaped and keeps the Agent-vs-Worker distinction clean (initial
deploy is more open-ended/Agent-shaped than a subsequent version bump).

## Your three flagged priorities

1. **Anjuna Confidential Computing Integration** (#21) — `needs build-out`, target **Agent**. Good BD angle stays
   intact regardless of extension type.
2. **Anjuna Upgrade Manager** (#22) — upgraded to `reuse-ready`, target **Worker**, after the session-2 sweep found
   its real source (`workspace/scriptlib/{aws-utils.sh,tf-utils.sh}` — see #22's row). Deliberately split from #21
   (version rollout is deterministic reconcile, not open-ended reasoning) — ship it as its own extension, not a
   mode of #21.
3. **Legacy Windows Discovery & Migration Assistant** (#23) — `needs build-out`, target **Agent**. See the note
   below — your instinct is right, but there's a real gap and a faster complementary win.

### On the Windows-specific candidate question

Your pick (#23) is the strongest **strategic** Windows candidate — deep methodology, nothing else in the backlog
touches AD/IIS/SQL dependency mapping. But it has a real gap this repo doesn't paper over: every scope this
dev-kit demonstrates (`aws`, `azure`, `kubernetes`, `github`, `gitlab`, `gcp`) gets you *cloud-API* access, not a
shell on a Windows guest OS. Reading real IIS bindings, AD auth mode, or SQL Server config needs a remote-execution
channel (SSM Run Command over the `aws` scope is the natural fit, or WinRM via a custom `other` scope) that no
sample here builds — budget discovery time for that seam specifically before writing skill logic. It's not a
blocker, just genuinely new ground, same class of gap as #24/#25 (SQL/AD backup-restore, same VM fleet).

If you want a **faster** Windows-flagged win to ship first while #23 is in build-out: **#13, the Windows/IIS
base-image generator** (guru/questce pattern — see #13's row for a correction: liftoff turned out not to share it)
has zero new-ground risk — it's a Dockerfile/entrypoint pattern proven identically across two customers already,
needs no remote-exec channel, and is a clean Passthrough. Ship that first, then tackle #23 once the SSM/WinRM seam
is validated.

### New-ground flags across the whole list

- **Windows remote-execution** (no sample) — #14, #23, #24, #25.
- **Jira via `other` scope** — #30 (ticket-scoping assistant) still has no *extension-shaped* sample, but a real
  working integration now exists to model the HTTP calls on: #47 (PR→Jira status sync, `incent/repo/Incent`)
  transitions issues and posts comments via the Jira REST API today. Use it as the reference for #30's `other`-scope
  plumbing.
- **Slack via `other` scope** (no sample, pattern only) — notification piece of #6.

## Generic vs customer-specific split

Quick-reference grouping of every row by [Classification](#how-to-read-this) — pulled out because it's the fastest
way to see which candidates are worth productizing for the whole customer base vs. which are one-account wins.
Full detail (source paths, scopes, tier) stays in the tables below; this list is just IDs + names.

**Generic (reusable pattern, config-only swap between customers)** — #1, #2, #3, #4, #5, #6, #7, #8 (confirmed at
2 customers — Payfinia *and* Incent, see #8's row), #9, #10 (**Built**), #11, #12, #13, #14, #15, #18, #19, #20,
#21, #22, #23, #24, #25, #26, #27, #29, #30, #31, #32 (confirmed at 2 customers — clientsavvy *and* Incent, see
#32's row), #34 (low confidence, see its row), #35, #36 (former #37 merged in, see its row), #39, #41, #44, #47 (mechanism generic, field
IDs/board customer-specific), #49, #50, #51, #52, #53, #54. Of these, 🏆 #21, #22, #35, #49, #50 are additionally
**3rd-party product extensions** — see
[the top strategic priorities section](#-top-strategic-priorities-generic-3rd-party-product-extensions-2026-09-15).

**Customer-specific (hardcoded business logic, tenant layout, or one-off asset)** — #16 (FedNow is Payfinia's
payment rail), #17 (RTP-specific), #28 (Payfinia's own incident history), #33 (tied to MoreThanRewards' AWS
Transform reports), #38, #40 (schema-specific dataflow config), #42, #43, #45, #46.

## 2026-09-15 sweep findings

Swept three checkouts not covered by the original 2026-08-17 pass: `payfinia/repo/devops`,
`incent/repo/Infrastructure`, `incent/repo/Incent`. Two things came out of it:

1. **New candidates** — #35–#48 below, added to their tiers in place.
2. **Backlog items #1, #2, #3, #4, #5, #14, #15, #30 were not found under `incent/repo/Infrastructure` or
   `incent/repo/Incent`** — grepped for every named script/skill (`phase1a-*.sh`, `azure-cost-report.py`,
   `sql-connection/windows-sql-troubleshoot.ps1`, `jira-ticket-analysis/`, `duplo-aws-infra` etc.), zero matches in
   either repo. Those items' source artifacts live in a different Incent-related location — most likely
   `~/Documents/ai/claude-workspace/Incent/Costmanagement` (one of this session's other working directories) or a
   separate helpdesk-skills checkout. Left the rows as-is since the artifacts weren't disproven, just not local to
   these three folders — re-verify source paths next time that location is in scope. **Resolved in the session-2
   sweep below** — see that section.

## 2026-09-15 (session 2): `claude-workspace` + `workspace` / `anjuna` sweep

Same day, second pass. `~/Documents/ai/claude-workspace` turned out to be the user's master staging area — the
original/working copies of nearly everything already catalogued above, later copied into the per-customer git
repos swept in session 1. Also swept `~/Documents/workspace` and `~/Documents/anjuna` (Anjuna-tooling staging
copies) per the user's request, and confirmed a working theory floated mid-session about the user's own Jira
(Atlassian connector not yet authorized for this session — see the conversation for what pulling Payfinia's
`PFDO-*` tickets directly would add once it is).

**Resolved / newly sourced:**
- **#1, #2, #14, #30 CONFIRMED** at `Incent/scripts/`, `Incent/Costmanagement/`, `Incent/sql-connection/`,
  `Incent/jira-ticket-analysis/` respectively (exact files match the names already in the backlog). **#3, #4, #5,
  #15 (`incent-migration-planner`, `incent-customer-tracker`, `incent-containerization`, `duplo-aws-infra`,
  `duplo-dashboard`, `duplo-project-management`, `k8s-troubleshooting`) still not found anywhere** — grepped both
  `Incent/` and `duplocloud/` subtrees in claude-workspace, zero matches. These four items' source is genuinely
  unlocated after two full sweeps; either the skill packages live somewhere not yet swept, or they don't exist as
  files (e.g. only ever existed as chat-based Duplo AI Helpdesk sessions, never checked into a folder). Treat with
  lower confidence than the rest of the backlog until located.
- **#10 Multi-Cloud Customer Bootstrapper CONFIRMED BUILT** — a complete, genuinely generic skill package exists at
  both `duplocloud/skills/multi-cloud-customer-bootstrap/` and `workspace/ai/skills/infrastructure/multi-cloud-customer-bootstrap/`
  (`SKILL.md`, `README.md`, `templates/{aws,gcp,azure,common}/`, `examples/`). Its own `duplocloud/skills/BACKLOG.md`
  says outright: *"Already Built... Ready to upload to DuploCloud AI Studio."* **Status changed to `Built`** in the
  table below — this is the one item in the whole backlog that's past "Not started."
- **#22 Anjuna Upgrade Manager RESOLVED** — real source found at `workspace/scriptlib/{aws-utils.sh,tf-utils.sh,anjuna-version.sh}`
  (newer/canonical copy; a stale mirror exists at `anjuna/anjuna-tools/scriptlib/`, differing only in
  `anjuna-version.sh`'s pinned release number). **Moved from Tier 2 to Tier 1** — see the updated row.
- **#37 Duplo Reconciler Delete-Guard** corroborated a second time (same script pair, `pfdo-1063-rds-mysql-upgrade/`
  in claude-workspace, plus a written incident doc `duplo-reconciliation-investigation-2026-09-02.md` confirming 3
  live failed attempts) — strengthens confidence, no row changes needed.
- **#35 Anjuna webhook cert rotator** corroborated with real rotation history: `anjuna/anjuna-tools/webhook-tls-2025-07-25-{03,55,56,58}-old/`
  are dated snapshots from repeated real rotation attempts on 2025-07-25 (multiple tries minutes apart, 2 aborted
  mid-rotation) — this is production evidence the mechanism has actually been exercised, not just written.
- **#41 DuploCloud Terraform Multi-Project Deploy Wrapper** corroborated across *four* customer examples now
  (`workspace/examples/{cft,incent1,payfinia1,payfinia2}`, all sharing the same `_env.sh`/`_util.sh`/`plan.sh`/`apply.sh`
  wrapper shape with only tfvars differing) — strong signal this generalizes cleanly.
- **#13 correction** — the claim that the Windows/IIS base-image pattern is "proven across guru/liftoff/questce" is
  wrong: `liftoff/` has no Dockerfile/entrypoint.ps1 at all, only a Cypress CI failure log. The pattern is proven
  across **guru + questce only**. Row and customer list corrected below.
- **#23–#26 filename corrections** (`morethanrewards/vmware-migration/scripts/`): the AD restore script is
  `ad1-restore-from-s3-to-fsx.ps1`, not `restore-to-fsx.ps1`; the relay scripts are `relay-generic/relay-watch-and-ingest.ps1`
  and `relay-generic/source-package-and-push.bat`, not the shorter names previously logged.
- **#31 correction** — `terraform-k8s-master.zip` was misfiled against this row: it's an unrelated, large generic
  EKS/Helm platform scaffold branded for a different customer ("reejig"), not clientsavvy release material. Removed
  from #31's source citation; `release-process/release-strategy-plan.md` is the real (and richer than previously
  logged) source.
- **#33** — exact source path confirmed: `morethanrewards/vmware-migration/docs/aws-site-aws-transform.md` +
  the `migration_plan_report-*.html` / `mgn_import_consolidated-*.csv` files it describes ingesting.
- **#34 downgraded** — the two files behind this row don't actually describe an ops playbook: `duplocloud/helpdeskv2/scope`
  is a product-scoping note for DuploCloud's own AI Helpdesk v2/ARMOR, and `duplocloud/vm-update/steps` is a
  copy-pasted Slack/email thread about personal MDM (Rippling) enrollment — IT onboarding chatter, not devops
  automation. Left in Tier 3 but flagged low-confidence; needs re-scoping or removal, not build-out.
- **#50 IBM MQ Connect:Direct — substantially enriched**, no longer a bare placeholder. Found at
  `payfinia/ibm-direct-connect/` and `payfinia/ibm-directconnect/` in claude-workspace: a real 12-risk scoping
  document (`ibm-directconnect/questions.md`, PFDO-890) covering VM provisioning, networking, C:D configuration
  values, TLS certs, and detailed Dockerfile/containerization design questions; a reference manual-setup guide
  (`ConnectDirect_SecurePlus_Installation_Guide.md`) written and validated on Mac, not yet on Linux; and the actual
  IBM installer binaries downloaded (`IBM_CD_V6.4_UNIX_RedHat.tar.Z`, `IBM_CDWS_V6.4.0.0_RedHat_x64.tar.gz`). This
  is a real, in-progress POC — scoped and risk-assessed, containerization not yet built. Tier changed from
  greenfield to needs-build-out. See the updated row.

**New candidates found:**
- **#51 IBM License Service Deployment** (Payfinia, Tier 3) — a distinct, not-yet-actioned compliance requirement
  alongside #49.
- **#52 MQ Connectivity Test Client** (Payfinia, Tier 1) — reusable Python MQ ping/send-receive test tool.
- **#53 QuickSight RLS Promote Doctor** (Incent, Tier 2) — fixes a recurring CI/CD promote failure for QuickSight
  row-level-security.
- **#54 Consolidated Service Deploy Dispatcher** (clientsavvy, Tier 2) — collapses 11 per-service deploy workflows
  into 2 UI-driven dispatcher masters; related to but distinct from #12.

**Watched, not catalogued:** `4ldata/` (claude-workspace) looks like an early-stage candidate customer engagement
(one Azure activity-log CSV export, one two-line scope note) — too thin for a backlog row yet.

## 2026-09-16: candidate validation for `#36` (first build)

Cross-checked the RDS Blue/Green candidate against three external sources before committing to build it first.

1. **DuploCloud backend repo (`duplo`)** — the platform *does* have native RDS Blue/Green work in progress:
   `AwsRdsBlueGreenManager.cs`, `RdsBlueGreenApiController.cs`, `RdsBlueGreenDeployment.cs`, plus a real xUnit test
   file for the orphan-protection logic. It is **not a blocker**: the controller is gated behind
   `DISABLE_RDS_BLUE_GREEN` (feature flag, currently referenced as disabled-by-default in `SystemController`) and
   decorated `[JwtAuthNz(AuthType = AuthType.LocalHost)]` — unreachable from outside the backend process, so an
   extension cannot call into it even if the flag were on. A code comment in `DeleteDeployment` admits "the
   background reconciliation that flips \[SwitchoverCompleted\] is not yet wired up." Confirms the user's framing:
   real, but not something to build on or wait for. It did settle the exact engine boundary
   (`RDSConfiguration.SupportsBlueGreenDeployment()`: `MySql, PostgreSql, MariaDB, AuroraMySql, AuroraPostgreSql`
   only) and revealed that the native orphan-protection only covers deployments created through that same internal
   manager — see the corrected `#36` row for why this means our own delete-guard step stays permanently necessary,
   not just until the native feature ships.
2. **Company-wide "Extension Use Case" sheet** (Google Sheets, ~160 accounts) — no other account has asked for
   "RDS upgrade" by name, so this isn't a duplicate of anyone else's ask. It does show a real appetite for the same
   *category* of problem: "EKS Upgrade" appears for 3 separate accounts (Sureswift, Sureswift Leaddyno,
   Presencesleep), plus "Duplo-Host Patching" / "AMI upgrade" (Sureswift) and "EFS content deployments" +
   "EKS upgrades" (Abstractive) — a cluster of "automate a major-version upgrade that's currently manual and risky"
   asks, same shape as `#36`, different resource type. Also independently confirms `#27` (Bplogix's row verbatim:
   *"Automate Azure VM patchMode=AutomaticByPlatform enablement... no native hook in Duplo Terraform provider
   today"*) and surfaces one new, not-yet-scoped idea worth a future look: Incent/Nuuvia asked for "VPN S2S."
3. **ClickUp** (extension-testing-in-progress board) — **could not check**: the ClickUp MCP connector isn't
   authorized for this session. Authorize it via claude.ai's connector settings (or `/mcp` in an interactive
   session) and I can pull it directly next time; until then I can't confirm whether `#36` overlaps anything
   already in QA.

**Conclusion:** `#36` is validated as the first build — real customer-proven MySQL process in hand, no internal
platform conflict (native feature is inert for our purposes), no duplicate ask elsewhere, and a plausible template
for the EKS/AMI/host-patching upgrade-pattern cluster once built.

### Security flags from the session-2 sweep

Neither value is reproduced here or in `extensions.json` — only the location, so they can be rotated/scrubbed:
- `clientsavvy/database-migration/steps` (claude-workspace) contains a **plaintext AWS access key/secret pair**.
- `duplocloud/shared-dockerfiles/` (claude-workspace) has a **hardcoded plaintext local-admin password**
  (`Password~1234`) baked into a Windows entrypoint script — a related-but-distinct base-image source from #13's
  guru/questce pattern; worth scrubbing if this set is ever generalized or shared.
- `Incent/cdc/tables.tfvars` (claude-workspace) has real customer PII column names (SSN) checked in — not a
  credential, but sensitive data worth keeping out of any genericized/shared version of #40.

---

## 2026-09-22: PFDO-904 network-visibility refinement (Sanket's ask → `#56`/`#57`)

Sanket (internally) raised a broader ask that overlaps PFDO-904 (source of `#55`): Payfinia's network layer today has
**no proactive visibility** — VPN/S2S tunnel state, routing health, traffic flow, and network-side security posture
are only discovered reactively, when a customer reports a failed transaction. That's the same root cause behind the
Achieva prod VPN incident already captured as `#18` (missing TGW route, found only after the fact).

Rather than one monolithic "network" extension, this splits into the subsystems it actually is — each already has,
or now has, its own backlog row:
- **`#56` (new, build first)** — proactive VPN/S2S tunnel + routing health monitoring with alerting. Directly
  answers "no visibility until the customer complains." Cheapest to build well: `DescribeVpnConnections` returns
  per-tunnel status natively.
- **`#18`** (existing) — the reactive diagnose/fix Agent for when a tunnel or route issue is *found*. `#56` is its
  natural upstream trigger: v1 ships independently (`#56` alerts a human), v2 can have `#56`'s alert auto-invoke
  `#18`'s Agent.
- **`#55`** (existing) — traffic-flow discovery + audit overlay (VPC Flow Logs + CloudTrail). Unchanged scope.
- **`#48`** (existing) — network-side security posture/drift auditing. Unchanged scope.
- **`#57`** (new) — VPN provisioning from Excel intake (Rohit Singh's manual process). Confirmed via repo sweep
  (below) that no such extension or script exists today — only the customer-facing intake paperwork. Distinct
  *setup* concern from `#56`'s *monitoring* concern; captured as its own idea-stage row, not built now.

**Repo sweep for a pre-existing "VPN setup from Excel" tool (2026-09-22):** none found. What exists is paperwork
only — `payfinia/repo/devops/vpn-setup/{OnPoint,iThink}/*.pdf` + `Payfinia-iTHINK AWS_VPN_Customer_Form {PROD,TEST}
- 5.19.26.xlsx` (customer gateway IP, BGP ASN, tunnel config fields) and a blank template copy in claude-workspace.
One PDF is literally named `...rohit-update iTHink.pdf`, confirming Rohit's authorship of the *paperwork*, not code.
The only related automation anywhere is `#18`'s reactive route-fix scripts (not Excel-driven). This was already
implicitly confirmed by `#18`'s own row ("both are customer paperwork... no scripts") but is now explicit.

**Composition note (applies to `#56` and its future siblings):** rather than building `#55`/`#56`/`#48` as fully
separate, independently-deployed extensions that call each other over HTTP, the dev-kit's supported composition
pattern is **multiple resource types in one extension bundle** (flat siblings, sharing one DLL/manifest/DI
container — see [reference/08-parent-child-and-menus.md](.claude/skills/duplo-extension-dev/reference/08-parent-child-and-menus.md)).
Sibling resources registered in the same bundle can inject `IEntityService<TOther>` directly (in-process, typed, no
HTTP round-trip) — e.g. a future "Network Health Rollup" resource reading `#56`'s tunnel-status history and `#55`'s
undeclared-traffic edges to build one composite view. `#56` ships alone first; the multi-resource bundle is a v2+
decision once `#55`/`#48` are actually being built, not something to design speculatively now.

---

## Tier 1 — reuse-ready

| # | Extension idea | Source artifact(s) | Customer | Target type | Scope(s) | Classification | Status |
|---|---|---|---|---|---|---|---|
| 1 | Azure RBAC Audit & Remediation Suite | `phase1a-audit.sh`, `phase1a-owner-review.sh`, `phase1a-tempadmin-removal.sh`, `phase1a-developers-group-remediation.sh` | Incent | **Agent** | `azure` | generic | Not started |
| 2 | Cost Management Reporting Pipeline | `azure-cost-report.py`, `aws-cost-estimator.py`, `azure-resource-inventory.py`, `azure_sql_trend.py` (+ pytest suite) | Incent | **Worker** | `azure`, `aws` | generic | Not started |
| 3 | Migration Plan Generator | `incent-migration-planner` helpdesk skill | Incent | **Agent** | `azure`, `aws` | generic | Not started |
| 4 | Customer/Engagement Tracker | `incent-customer-tracker` helpdesk skill | Incent | **No-provision** | — | generic | Not started |
| 5 | Containerization Readiness Assistant | `incent-containerization` helpdesk skill | Incent | **Agent** | `azure`/`aws` (target-dependent) | generic | Not started |
| 6 | EKS/ASG Instance Scheduler ("Sleepy Environments") | `Automation-StartStop/` — `scripts/manage.sh`, per-app scripts, `config/inventory.json`, S3 state save/restore. **Confirmed same pattern in `payfinia/repo/devops`:** `automation/scripts/manage.sh`, `automation/config/inventory.json`, `.github/workflows/service-control.yml` (manual dispatch), `sync-inventory.yml` | Payfinia | **Worker** | `aws`, `kubernetes` | generic | Not started |
| 7 | Staged Canary Prod Promotion | `skills/paze-prod-deploy/SKILL.md` (nonprod→cat01→prod, approval gates) | Payfinia | **Agent** | `aws`, `kubernetes` | generic | Not started |
| 8 | Self-Hosted GitHub Runner Fleet Manager | `custom-runner/duplo-runner-bootstrap.sh`, `duplo-runner-status.sh`. **Confirmed at a 2nd customer:** `incent/repo/Incent/.github/workflows/manage-runners.yml` — already calls the DuploCloud platform API (`DUPLO_HOST`/`DUPLO_TOKEN`/`DUPLO_TENANT`) directly to start/stop Windows self-hosted runner VMs, gated on GH API runner-online checks. Two independent implementations of the same pattern — good sign this generalizes cleanly. | Payfinia, Incent | **Worker** | `github`, `aws`, `other` (DuploCloud API) | generic | Not started |
| 9 | MGN/Relay IAM Bootstrapper | `vmware-migration/scripts/mgn-agent-iam-setup.sh`, `relay-vm-iam-setup.sh` | MoreThanRewards | **Passthrough** | `aws` | generic | Not started |
| 10 | Multi-Cloud Customer Bootstrapper | `duplocloud/skills/multi-cloud-customer-bootstrap/` (full skill package: `SKILL.md`, `README.md`, `templates/{aws,gcp,azure,common}/`, `examples/{cdc,cft,incent1,payfinia1,payfinia2}` — a 2nd copy exists at `workspace/ai/skills/infrastructure/multi-cloud-customer-bootstrap/`). Genuinely generic: takes `customer_slug`/`cloud`/`environments` inputs and emits a standard admin-infra/admin-tenant/app Terraform layout for AWS, GCP, or Azure. Its own `duplocloud/skills/BACKLOG.md` says *"Already Built... Ready to upload to DuploCloud AI Studio."* The bundled `examples/` are literal (not anonymized) copies of real customer implementations kept as reference, not further genericized. | duplocloud internal | **Agent** | `aws`, `azure`, `gcp` | generic | **Built** |
| 11 | Azure Cross-Subscription Image Sharer | `duplocloud/azure/container-image-sharing.sh` (confirmed 2026-09-15: the only file in that folder, clean and parameterized, no hardcoded customer data) | duplocloud internal | **Passthrough** | `azure` | generic | Not started |
| 12 | Tenant GitHub Workflow Dispatcher | `githubworkflow-runs/github-workflow-run-script` (curated `gh workflow run` per tenant/repo). Confirmed 2026-09-15: a flat list of `gh workflow run --repo clearlyrated/cft-{legacy,modern-api,modern-web} --field duplo_tenant_name=dev02` commands, one per service, with 2 of 9 services (legacy-fed, entrasso) never filled in — a real, if incomplete, curated dispatch list. | clientsavvy | **Passthrough** | `github` | generic | Not started |
| 13 | Windows/IIS Base-Image Generator | Near-identical Dockerfile + `entrypoint.ps1` pattern across **guru and questce only** — corrected 2026-09-15: `liftoff/` was re-checked and has no Dockerfile/entrypoint.ps1 at all (only a Cypress CI failure log), so it doesn't belong to this pattern despite earlier assumption. A related-but-distinct base-image source also exists at `duplocloud/shared-dockerfiles/` (legacy ASP.NET 4.8 / Windows Server Core 1809 + IIS, batch/PowerShell entrypoint config-substitution) — ⚠️ has a hardcoded plaintext local-admin password, scrub before reuse (see [security flags](#security-flags-from-the-session-2-sweep)). | guru, questce | **Passthrough** | `aws` (ECR) or `azure`/`gcp` | generic | Not started |
| 35 | 🏆 Anjuna Nitro Webhook TLS Cert Rotator | `payfinia/repo/devops/automation/anjuna-cert-upgrade/` — `README.md`, `scripts/00-precheck.sh`…`03-apply-and-rotate.sh`, `lib.sh`, `config/{nonprod,prod}-anjuna-system.env`. 4-step confirmation-gated rotation of the `anjuna-nitro-webhook` admission-controller TLS cert: precheck → backup Secret/Helm-values/webhook-config to `.state/` → generate new CA+leaf via openssl → patch the live k8s Secret + `helm upgrade --reuse-values` the `caBundle` + rolling-restart, behind a typed `APPLY-<ENV>-ANJUNA-CERT` confirmation. Distinct from #21/#22 — this is cert-lifecycle, not the integration build-out or the version-upgrade helpers. | Payfinia (anjuna) | **Worker** | `kubernetes` | generic | Not started |
| 36 | RDS Major-Version Upgrade Orchestrator (Blue/Green) — **BUILT 2026-09-16, internal/proof-of-concept** | `payfinia/repo/devops/automation/rds-mysql-upgrade/` — `README.md`, `scripts/00-precheck.sh`…`07-cleanup.sh`, `99-rollback-pre/post-switchover.sh`, `lib.sh`, `config/p-*.env`. **v1 shipped as `extensions/rdsupgrade/` in this devkit repo** (`duplo.examples.rdsupgrade` v0.1.1), hot-loaded onto `helpdesk-dev01.test21-apps.duplocloud.net` / `prasanna-ws`. Scope narrowed during build: **no human-approval gate** — the two-gate design below was the original plan, but `ResourceWorkerBase`'s multi-tick "wait indefinitely" semantics couldn't be verified from available docs/source (the AI Studio backend isn't checked out anywhere locally), so v1 is a **single-shot automated run** (precheck → snapshot → clone param group → create Blue/Green, guarded → validate → switchover → post-verify → cleanup, all in one `ApplyAsync` call with in-call polling, not cross-tick waiting). This is explicitly internal/portfolio work, not customer-facing, which is why that trade-off was acceptable — re-add the approval gate before pointing this at a real customer database. AWS Blue/Green Deployments support exactly `MySQL, MariaDB, PostgreSQL, Aurora MySQL, Aurora PostgreSQL` (confirmed against the DuploCloud backend's own `RDSConfiguration.SupportsBlueGreenDeployment()`); v1 is tested MySQL-only but the schema is engine-parametric. The delete-guard (formerly tracked as #37) is folded in as an internal step at `CreatingBlueGreen`/`CleaningUp`. **Verified live**: built clean (backend + Angular Native Federation frontend), deployed, registered on the platform, and a real create→fail→cleanup lifecycle test surfaced and confirmed the fix for a genuine bug (the initial AWS-client-resolution call sat outside the try/catch, so a scope failure left `Result.Phase` stuck at "Requested" with empty `StepHistory` even though the resource showed `Failed` — moved inside the try, redeployed as v0.1.1, re-verified clean). **Not yet tested**: the real AWS happy path — `prasanna-ws` has no AWS scope attached yet, so live RDS calls are unverified; also research precedent found in the `duplo` repo's native (non-extension) `EksUpgradeBase` — a step-chain + persisted-progress-state + periodic-sweep reconciler — as the reference pattern for adding the approval gate(s) back in v2. | Payfinia (methodology), internal/portfolio (v1 build) | **Worker** | `aws` | generic | **Built** |
| — | ~~Duplo Reconciler Delete-Guard~~ — **merged into #36, 2026-09-16** | Was `payfinia/repo/devops/automation/rds-mysql-upgrade/{pre-apply-rds-delete-deny.sh,post-remove-rds-delete-deny.sh}`, previously logged as a standalone item. **Correction: the user built this specifically as part of the Blue/Green upgrade process** (to stop Duplo's tenant reconciler deleting the green instance mid-creation, confirmed 3 live failures), not as a general-purpose product — folded into #36 as an internal step, no longer tracked as its own row. **Cross-checked against the DuploCloud backend's native orphan-protection logic (`AwsRdsBlueGreenManager.GetBluegreenProtectedIdentifiersFromAws`/`CleanOrphanBgDeployments` in the `duplo` repo, 2026-09-16): that native protection only covers deployments created through the backend's own `CreateDeployment` manager** (it keys off `tenant.RDSInstances[...].BlueGreenDeploymentIdentifier`, set only by that call path). Since the native `RdsBlueGreenApiController` is `LocalHost`-auth only — unreachable from an extension — our extension must create the AWS-level deployment directly, which the native protection will never see. **This means the IAM-Deny guard step stays necessary inside #36 even after the native feature ships**, not just as a stopgap. | Payfinia (discovered) | (folded into #36) | `aws` | generic | — |
| 22 | 🏆 **Anjuna Upgrade Manager** 🎯 priority — RESOLVED 2026-09-15 | `workspace/scriptlib/{aws-utils.sh,tf-utils.sh,anjuna-version.sh}` (canonical/newer copy; a stale mirror exists at `anjuna/anjuna-tools/scriptlib/`, differing only in `anjuna-version.sh`'s pinned `RELEASE_NUMBER`). `aws-utils.sh` wraps the ECR mechanics for a version bump: `aws_ecr_upload_docker_image`/`aws_ecr_tag_push_docker_image` compare local image digest vs. the ECR remote digest via `aws ecr describe-images` and skip the push if they already match — check-then-conditionally-push idempotency, exactly what a repeatable upgrade manager needs to avoid redundant re-pushes. `tf-utils.sh` wraps the Terraform lifecycle around the EKS Anjuna cluster: `tf_apply`/`tf_destroy`/`tf_clean` (guarded — refuses to clean while `terraform.tfstate` still has resources), `tf_configure_kubectl` (pulls `cluster_name`/`region` from `terraform output` into `aws eks update-kubeconfig`), and `tf_get_webhook_ca_b64` (reads the webhook CA cert straight out of Terraform output, tying directly into #35). Moved from Tier 2 to Tier 1 — this is working code, not a missing artifact. | Payfinia (anjuna) | **Worker** | `aws`, `kubernetes` | generic | Not started |
| 39 | Cross-Cloud SQL Server Migration Pipeline (Azure→S3→RDS) | `incent/repo/Infrastructure/scripts/db-migration/{_common.sh,01-export-azure-db.sh,02-copy-to-s3.sh,03-restore-to-rds.sh,migrate-db.sh}`. `az sql db export` → `.bacpac` to Blob → download + `aws s3 cp` to staging → `sqlpackage /Action:Import` (bacpac, with a grant-stripping Python step RDS requires) or RDS-native `rds_restore_database` (`.bak`) with completion polling; parameterized by a `<slug>` config lookup, falls back to `duplo-jit` for AWS creds. **This is working code for the same pattern #32 only had docs for** — see #32's updated row. | Incent | **Worker** | `azure`, `aws` | generic | Not started |
| 41 | DuploCloud Terraform Multi-Project Deploy Wrapper | `incent/repo/Infrastructure/devops/infra/scripts/{_env.sh,_env_prod.sh,_util.sh,plan.sh,apply.sh,destroy.sh,import.sh,duplo-api.sh}`. Pulls short-lived AWS creds via DuploCloud JIT (`adminproxy/GetJITAwsConsoleAccessUrl`), sets S3+DynamoDB TF backend per account, selects/creates a workspace per tenant, runs plan/apply/destroy/import across an ordered stack chain reading upstream remote-state outputs. Nothing incent-specific in the scripts themselves (only the stack code/tfvars are). CI surface: `.github/workflows/build-terraform.yml`. | Incent | **Worker** / **Passthrough** | `aws`, `other` (DuploCloud API) | generic | Not started |
| 44 | Azure App Service Inventory | `incent/repo/Incent/scripts/list-all-app-services.sh`. One-shot enumeration of App Services across every accessible Azure subscription, writes `configuration/masterdata/all-app-services-live.json`. No Incent business logic — pure Azure discovery utility. | Incent | **No-provision** | `azure` | generic | Not started |
| 49 | 🏆 IBM MQ Native HA Deployment & Lifecycle Manager | `payfinia-ibmmq/{GENERATOR-README.md,mq-ha-architecture-v4.md,mq-ha-generator-v4-main.sh,mq-ha-generator-terraform-k8s.sh,mq-ha-generator-phases4-5.sh}`, generated output at `payfinia-ibmmq/payfinia-mq-ha-infrastructure/{terraform/*.tf (9 files: vpc, transit-gateway, security-groups, iam, eks, outputs, main…), kubernetes/*.yaml (8 files: namespace, serviceaccount, storage-class, configmap-mqsc, configmap-mqini, statefulset-mq-ha, service-mq-nlb, network-policy), scripts/{install.sh,create-secrets.sh,deploy-mq.sh,configure-post-installation.sh,setup-monitoring.sh,setup-alarms.sh,backup-all.sh,test-connectivity.sh,test-failover.sh,cleanup.sh}}`. Duplicated at `payfinia/repo/ipx.rtp/ipx-infra-setup/`. v4.0 IaC generator with 95% automation for deploying IBM MQ Native HA (3-5s failover) across 3 AZs on EKS: Phase 1-3 stands up a 3-VPC design (network/MQ-HA/app VPCs over Transit Gateway) + the HA StatefulSet; Phase 4 automates cross-VPC routing/security-group config (parameterized by VPC/SG IDs + partner IPs, not hardcoded); Phase 5 automates CloudWatch monitoring/alerting; plus standalone backup and failover-test scripts. Upgrade-in-place evidence: `payfinia-prod/ibmmq-upgrade/{qm-config-backup.mqsc,statefulset-backup.yaml}` shows a real upgrade was performed with a pre-upgrade backup. Only the TCH partner IPs passed as Phase-4 arguments are customer-specific; the generator itself has zero hardcoded business logic. 🏆 flagged 2026-09-15 as a top strategic 3rd-party product extension. | Payfinia | **Agent** (initial deploy) / **Worker** (upgrade, monitoring, backup) | `aws`, `kubernetes` | generic | Not started |
| 52 | MQ Connectivity Test Client | `payfinia/mqclient/` (claude-workspace) — `ping.py` (HTTP health-check against an MQ REST endpoint, with mTLS/basic-auth support) + `mq_client.py` (uses `pymqi` to open a SVRCONN channel and send/receive a test message against a real queue) + `tests/test_ping.py` (network-isolated unit tests) + README. A small, clean, reusable "verify an MQ queue manager end-to-end via CLI" tool — distinct from the Helm/Terraform-focused IBM MQ items (#29, #38, #49), this is a connectivity/smoke-test utility that'd pair well as a verification step inside any of them. | Payfinia | **No-provision** | `aws`, `kubernetes` | generic | Not started |

## Tier 2 — needs build-out

| # | Extension idea | Source artifact(s) | Customer | Target type | Scope(s) | Classification | Status |
|---|---|---|---|---|---|---|---|
| 14 | Windows SQL Connectivity Doctor 🚩 **NEW GROUND** | `sql-connection/windows-sql-troubleshoot.ps1` | Incent | **Agent** | `aws`/`azure` + Windows remote-exec | generic | Not started |
| 15 | Generic Helpdesk Skill-Pack → Extension Conversion | `duplo-aws-infra`, `duplo-dashboard`, `duplo-project-management`, `k8s-troubleshooting` skills | Incent | **Agent** | `aws`, `kubernetes` | generic | Not started |
| 16 | FedNow OpenSearch Alert Consolidator | `fednow-alerts-opensearch/create_consolidated_monitors.py` + `monitor-payloads/` (214→~20 monitors) | Payfinia | **Worker** | `aws` | customer-specific | Not started |
| 17 | RTP Alert Definition Manager | `rtp-alerts/` — Fluent Bit config + CloudWatch/OpenSearch alert defs | Payfinia | **Worker** | `aws` | customer-specific | Not started |
| 18 | VPN/TGW Connectivity Doctor ↔ **pairs with `#56`** | `pfdo-1060-achieva-prod-vpn-issue/scripts/` (reactive route-fix scripts; root cause was missing TGW route + shared route table). Swept `payfinia/repo/devops/vpn-setup/{OnPoint,iThink}` looking for companion automation — both are PDFs/Excel customer paperwork only, no scripts; not a new source, just confirms this candidate's automation lives solely in the ticket path above. **2026-09-22:** `#56` is the proactive counterpart — it detects the tunnel-down/missing-route condition this Agent already knows how to fix; v2 can chain `#56`'s alert straight into this Agent. | Payfinia | **Agent** | `aws` | generic | Not started |
| 19 | NLB Targetless Auto-Heal ⭐ high value, low new-ground risk | Known recurring platform bug + full diagnostic recipe (`aws autoscaling attach-load-balancer-target-groups` fix) | Payfinia | **Worker** | `aws` | generic | Not started |
| 20 | Node Group Right-Sizer | `pfdo-1040-increase-node-group/` (planning notes) | Payfinia | **Worker** | `aws`, `kubernetes` | generic | Not started |
| 21 | 🏆 **Anjuna Confidential Computing Integration** 🎯 priority | `anjuna-k8s.sh`, `build-/export-anjuna-docker-images.sh`, `generate-webhook-tls-cert.sh`, Terraform for Nitro EKS. Confirmed via `payfinia/repo/devops/infra/terraform/anjuna/` (`anjuna.tf`, `s3-anjuna-files.tf`, `helm-charts/anjuna-tools/templates/{anjuna-nitro-webhook.yaml,anjuna-metrics-server.yaml}`) — per #35's README, the *live* `anjuna-tools` Helm release was installed by hand (`kubectl create namespace` + `helm install`, client-side-apply) and is **not** tracked by this Terraform, i.e. the integration build-out needs to decide whether to bring the release under Terraform/extension management or keep the split. | Payfinia (anjuna) | **Agent** | `aws`, `kubernetes` | generic | Not started |
| 23 | **Legacy Windows Discovery & Migration Assistant** 🎯 priority · 🚩 **NEW GROUND** | Full VM/IIS/AD/SQL discovery methodology, OS-era routing, `collect-vm-inventory.bat`, `network-bandwidth-test.ps1`, AWS Transform reports | MoreThanRewards | **Agent** | `aws` + Windows remote-exec | generic | Not started |
| 24 | SQL Server Backup/Restore-to-S3 Scheduler 🚩 **NEW GROUND** | `vmware-migration/scripts/mssql10-backup-to-s3.ps1` (filename confirmed 2026-09-15) | MoreThanRewards | **Worker** | `aws` + Windows remote-exec | generic | Not started |
| 25 | AD Extract/Restore-to-FSx Scheduler 🚩 **NEW GROUND** | `vmware-migration/scripts/ad1-extract-to-s3.ps1`, `ad1-restore-from-s3-to-fsx.ps1` (restore filename corrected 2026-09-15 — was previously logged as `restore-to-fsx.ps1`) | MoreThanRewards | **Worker** | `aws` + Windows remote-exec | generic | Not started |
| 26 | Cutover File Relay (continuous sync) | `vmware-migration/scripts/relay-generic/{relay-watch-and-ingest.ps1,source-package-and-push.bat}` (filenames corrected 2026-09-15) | MoreThanRewards | **Worker** | `aws` | generic | Not started |
| 27 | Azure VM Patch-Mode Enforcer | Single validated ask: enforce `patchMode=AutomaticByPlatform` (no native Terraform-provider hook). Confirmed 2026-09-15: `bplogix/scope` is literally this one ask plus a supporting screenshot — nothing else in the folder. | bplogix | **Passthrough** | `azure` | generic | Not started |
| 38 | RTP TCH Signature Cert Rotator | `payfinia/repo/devops/rtp-automation/signature-keys/`. Backup/stage/swap/cutover of a k8s Secret holding TCH's RTP public cert — editing the underlying `.pfx` binary data via the Duplo portal corrupts it, hence the script path. Same rotate-a-k8s-Secret-safely shape as #35, but tied to TCH/RTP naming and the RTP payment rail specifically. **Note (2026-09-15):** `TCH-Cert-Update-20260807/` in claude-workspace is a *different* TCH certificate — TCH's network-layer mTLS switch cert for the RTP connection itself, not this application-layer payment-signature cert. Reference/PDF material only, no automation yet; don't conflate the two when scoping build-out. | Payfinia | **Worker** | `kubernetes` | customer-specific | Not started |
| 40 | Azure SQL CDC → S3 Parquet Pipeline Provisioner | `incent/repo/Infrastructure/change_data_capture/{common,adf,terraform}/*.tf`, `config/dev01/{common,adf}.tfvars`, `CDC_overview.md`. Terraform-provisions ADF + Key Vault + self-hosted Integration Runtime + linked services, then per `(database × table)` in tfvars generates a CDC-enabled `SqlServerSource`→`ParquetSink` dataflow (Snappy, S3) wrapped in a pipeline + monthly trigger; `adf/main.tf` locals derive resource names from the cross-product automatically. The ADF-CDC-to-S3 scaffolding is reusable; the checked-in table column schemas (e.g. incent's `Children` table) are Symitar/incent business schema and would need to become extension inputs rather than tfvars. | Incent | **Worker** / **No-provision** | `azure`, `aws` | generic mechanism / customer-specific schema | Not started |
| 42 | Customer Deploy Onboarding Flow | `incent/repo/Incent/scripts/fetch_customer_assets.sh`, `.github/scripts/sync-github-env.sh`, `.github/scripts/run-workflow.sh`, `.github/scripts/run-batch.sh`, `.github/workflows/manage-customers.yml`; documented in `configuration/{README.md,manual-run.md}`. Pulls a customer's live `web.config`/CSS/images/fonts from Azure App Service via Kudu, exports a secrets JSON, syncs it into a GitHub Environment's vars/secrets, then dispatches the build workflow. Pattern (pull cloud config → sync CI secrets → trigger deploy) is generic; the implementation is keyed off Incent's `configuration/customers.json`. | Incent | **Worker** | `azure`, `github` | customer-specific | Not started |
| 43 | Admin Portal Config Sync & Deploy | `incent/repo/Incent/.github/scripts/fetch-admin-config.sh` + `.github/workflows/{manage-admin.yml,deploy-admin.yml}`. Same Kudu-config-pull-and-sync shape as #42, separate pipeline for the `IncentAdmin` App Service (extracts connection strings/DevExpress theme). | Incent | **Worker** | `azure`, `github` | customer-specific | Not started |
| 45 | Multi-Customer Rollback | `incent/repo/Incent/.github/workflows/rollback.yml` + `.github/scripts/resolve-customer.js`. Operator picks a customer key, workflow resolves Azure/GitHub config and runs a Windows self-hosted `msdeploy` revert with per-customer concurrency guarding. "One-click rollback keyed by tenant config" is a reusable shape, but the picklist/config resolution is Incent-specific. | Incent | **Worker** | `azure`, `github` | customer-specific | Not started |
| 46 | Master Deploy (Batch Multi-Tenant Release) | `incent/repo/Incent/.github/workflows/master-deploy.yml`, `.github/scripts/{resolve-master-deploy.js,generate-master-deploy.js}`. Fans a deploy out across up to 5 customer environments chosen from a ~30-tenant picklist in one dispatch. Picklist is hardcoded to Incent's tenant roster. | Incent | **Worker** | `azure`, `github` | customer-specific | Not started |
| 47 | PR-to-Jira Status Sync | `incent/repo/Incent/.github/workflows/{jira-merge-to-qaready.yml,jira-pr-review.yml}`. On merge, transitions the linked Jira ticket to "QA Ready" (checking a PR-approval custom field, else comments/tags reviewers); on PR approval, posts a Jira comment via a hardcoded GitHub-login→Jira-accountId map. PR-review-triggers-Jira-transition is a generic pattern; the field IDs/board/login-map are Incent-specific. **Resolves part of #30's NEW GROUND flag** — real Jira REST API code to model from now exists (see [New-ground flags](#new-ground-flags-across-the-whole-list)). | Incent | **Passthrough** | `github`, `other` (Jira) | generic pattern / customer-specific config | Not started |
| 50 | 🏆 IBM MQ Connect:Direct Integration — enriched 2026-09-15, moved from greenfield | `payfinia/ibm-direct-connect/{Dockerfile (empty stub),scope,downloads/,"Payfinia_ConnectDirect_Dev_Setup_Guide (2).md"}` and `payfinia/ibm-directconnect/{ConnectDirect_SecurePlus_Installation_Guide.md,questions.md,scope}` (claude-workspace). `questions.md` (ticket PFDO-890) is a real 12-risk scoping document covering VM provisioning, networking, IBM C:D configuration values (node name, listener/API/CDWS ports), TLS certs (`rtp-cd-2026.payfinia.net`), and detailed Dockerfile design questions (foreground PID 1 vs. supervisord, multi-stage build, root vs. non-root, config baked-in vs. injected, stateful-volume mounts, `--privileged` requirement for SUID binaries, hostname-pinning, ECR push strategy, healthchecks). Reference guide (`ConnectDirect_SecurePlus_Installation_Guide.md`) documents a manual setup validated on Mac (Docker Desktop, `--platform linux/amd64` emulation) — explicitly **not yet validated on native Linux**. Actual IBM installer binaries are downloaded (`IBM_CD_V6.4_UNIX_RedHat.tar.Z`, `IBM_CDWS_V6.4.0.0_RedHat_x64.tar.gz`). This is a real, actively-scoped POC — containerization not yet built, but far past idea-stage. Same TCH/RTP integration context as #49. | Payfinia | **Agent** (initial deploy, given the open design questions) / **Worker** (subsequent ops) | `aws` | generic | Not started |
| 53 | QuickSight RLS Promote Doctor | `Incent/rls-workflow/{promote_rls.sh,substitute_arns.sh}` (claude-workspace). Diagnoses and fixes a recurring CI/CD promote-pipeline failure for QuickSight row-level-security datasets — `substitute_arns.sh` swaps environment-specific ARNs during promotion, `promote_rls.sh` orchestrates the promote. Generic pattern (any QuickSight RLS promote pipeline hits ARN-substitution issues across environments); the specific ARNs/dataset names are Incent's. | Incent | **Worker** | `aws` | generic | Not started |
| 54 | Consolidated Service Deploy Dispatcher | `clientsavvy/workflowupdate/docs/superpowers/plans/2026-05-21-cft-legacy-deploy-workflows.md` + `conversation` (claude-workspace). A design doc (not yet built) for consolidating 11 separate per-service GitHub Actions workflow files into 2 UI-driven `workflow_dispatch` masters (nonprod/prod) with service + tenant + branch dropdowns and per-tenant service-name resolution (handles a real inconsistency: `DEV01` hyphenated tenant naming vs. camelCase elsewhere). Related to but distinct from #12 (which is a curated list of individual dispatch commands, not a consolidated UI) — the generalizable piece is "collapse N per-service deploy workflows into one parameterized dispatcher." | clientsavvy | **Passthrough** | `github` | generic | Not started |

## Tier 3 — greenfield

| # | Extension idea | Source artifact(s) | Customer | Target type | Scope(s) | Classification | Status |
|---|---|---|---|---|---|---|---|
| 28 | Incident Runbook Knowledge Base | One-off incident folders (nginx, nexus, ssh, mysql) — individually not reusable, collectively a KB | Payfinia | **No-provision** | — | customer-specific | Not started |
| 29 | IBM MQ Helm Tuning Advisor | `mqclusterbackup/` Helm value tuning notes | Payfinia | **Worker** | `kubernetes` | generic | Not started |
| 30 | Jira Ticket-Scoping Assistant 🚩 **NEW GROUND** (partially resolved, see #47) | `jira-ticket-analysis/` manual notes | Incent | **Agent** | `other` (Jira — pattern only, but #47 now gives real REST-call code to model against) | generic | Not started |
| 31 | Release Strategy Orchestrator | `clientsavvy/release-process/release-strategy-plan.md` — a concrete "CFT Production Release Strategy" doc: 3-job build→notify→deploy pattern, GitHub Environment approval gates (named reviewers), Slack notify, tag-naming convention across 4 repos (`cft-legacy`, `cft-entra-sso`, `cft-modern-api`, `cft-modern-web`). **Correction (2026-09-15): `terraform-k8s-master.zip` was misfiled against this row** — it's an unrelated, large generic EKS/Helm platform scaffold (60+ add-ons: Argo CD, Karpenter, Prometheus stack) branded for a different customer ("reejig"); removed from this citation. | clientsavvy | **Agent** | `github` | generic | Not started |
| 32 | Cross-Cloud DB Migration Runbook Automator ⬆ **upgrade candidate, see #39** | `clientsavvy/database-migration/{download-bak-from-s3,import-cloudsql-bak,migrate,rename-database,upload-bak-to-gcs}.ps1` + `steps` — EC2 SQL Server → S3 → GCS → Cloud SQL runbook. Confirmed 2026-09-15 as real scripts, not docs-only as previously logged. ⚠️ `steps` contains a plaintext AWS access key/secret pair — see [security flags](#security-flags-from-the-session-2-sweep), do not propagate the value. The 2026-09-15 (session 1) sweep also found **working code for the same pattern shape** (Azure SQL → S3 → RDS instead of EC2 SQL Server → GCS → Cloud SQL) at #39 in `incent/repo/Infrastructure`. Source cloud/target differ but the shape — export → object-storage staging → cloud-native restore, polling for completion — is identical. Worth merging into one extension with a pluggable source/target, or promoting this row to Tier 1 on the strength of #39's code once #39 is genericized. | clientsavvy, Incent (#39) | **Agent** / **Worker** | `gcp`, `aws`, `azure` | generic | Not started |
| 33 | AWS Transform Plan Importer | AWS Transform-generated migration plan reports. Exact source confirmed 2026-09-15: `morethanrewards/vmware-migration/docs/aws-site-aws-transform.md` + the `migration_plan_report-*.html` / `mgn_import_consolidated-*.csv` files it describes ingesting. | MoreThanRewards | **No-provision** | `aws` | customer-specific | Not started |
| 34 | Internal Ops Playbook Pack ⬇ **downgraded, low confidence — see note** | `duplocloud/helpdeskv2/scope` + `duplocloud/vm-update/steps` notes. **Re-checked 2026-09-15: neither file actually describes an ops playbook.** `helpdeskv2/scope` is a product-scoping note for DuploCloud's own AI Helpdesk v2/ARMOR product; `vm-update/steps` is a copy-pasted Slack/email thread about personal MDM (Rippling) enrollment — IT onboarding chatter, not devops automation. This row needs re-scoping against a real source, not build-out, before it's trustworthy. | duplocloud internal | **No-provision** | — | generic | Not started |
| 48 | IaC Drift & Security Posture Auditor | `payfinia/repo/devops/docs/iac-audit/` — a one-time manual Terraform-coverage/security audit report (untracked API Gateways, VPNs, security-group findings). No accompanying script exists — the audit was done by hand, so this is idea-stage only despite the report itself being concrete. | Payfinia (idea source) | **Agent** / **No-provision** | `aws` | generic | Not started |
| 51 | IBM License Service Deployment | `payfinia/ibmmq/IBM-MQ-Native-HA-Implementation.md` (claude-workspace) flags this as Critical Gap T-4/T-5/T-6: IBM's mandatory **License Service** (`ibm-licensing-cluster-scoped` Helm chart) for Cloud-Pak/certified-container audit/compliance reporting is **not yet deployed** in either NonProd or Prod. Distinct, small, not-yet-actioned component alongside #49 — same IBM MQ Native HA context, but its own deployable unit. | Payfinia (gap identified) | **Passthrough** | `kubernetes` | generic | Not started |
| 55 | Network Traffic Flow & Audit Overlay 🚩 **NEW GROUND** | Sourced from epic PFDO-904 ("Network Topology, Traffic Flows, and Audit Framework" — `[DevOps] Discussion - Network topology and traffic flow diagram` call, 2026-06-30, Nizar Jamal/Vinuja Jebaraj/Rohit Singh/Venkat Thiruvengadam/Prasanna Venkatesh). No existing script — idea-stage. Nizar's confirmed, still-unmet requirements from that call: bidirectional traffic visibility ("I can't have traffic initiated from inside a network I don't know about"), change attribution for manual AWS changes, and dynamic traffic-flow discovery overlaid on Duplo's existing static Terraform/live-state resource graph ("infrastructure is static, but app traffic is what makes dependencies dynamic"). Venkat confirmed on the call Duplo doesn't do this today, no committed timeline — this extension closes that gap directly rather than waiting on the core product roadmap. MVP: a **Worker** polls VPC Flow Logs (cost-preferred over an IDS appliance — the epic's cost trade-off is still open, don't build IDS ingestion for v1) + CloudTrail for network-relevant API calls (SG/route-table/VPN/TGW changes with actor identity), normalizes into `TrafficEdge` records, correlates src/dst against Duplo's already-discovered resource inventory, and flags edges with no match on either end as "undeclared" — the literal mechanism behind Nizar's quote. List/filter frontend is a stock pattern (reuse a `worker-appstack`-style list); a topology/graph visualization is genuinely new ground — no existing dev-kit sample renders a network graph, so treat that as its own build risk and ship list+filter first. Cleanest credential story in the whole backlog: `aws` only, all read-only Describe/LookupEvents/Logs calls, no `other_scopes` wiring needed. **2026-09-22:** sibling of `#56` (tunnel/route health) and `#48` (security posture) — see the [2026-09-22 refinement note](#2026-09-22-pfdo-904-network-visibility-refinement-sankets-ask--56-57) for how these compose. Build order: `#56` first. | Payfinia (idea source, PFDO-904) | **Worker** | `aws` | generic | Not started |
| 56 | 🎯 **VPN/S2S Tunnel & Routing Health Monitor with Alerting** — build first | Sourced from PFDO-904 thread, 2026-09-22: Sanket's ask for proactive network visibility — "currently no visibility, only when customer says or transactions fail." Same root cause as `#18`'s Achieva prod incident (missing TGW route, discovered only after the fact) but framed as continuous monitoring instead of one-off reactive fix. No existing script — idea-stage, but low new-ground risk: AWS's `DescribeVpnConnections` API returns per-tunnel status (`UP`/`DOWN`), status message, and last-status-change time natively; `DescribeRouteTables` surfaces missing TGW/VGW routes the same way `#18`'s incident diagnosis did by hand. MVP: a **Worker** polls configured AWS scopes (multi-account: nonprod/prod/networking, per the 2026-07-09 comment on PFDO-904 confirming those three accounts) on an interval, snapshots tunnel + route state, and on a state transition (tunnel flips to `DOWN`, an expected route disappears) writes a persisted incident record (start/end/duration, an audit trail — not just current state) and fires an alert via a configurable channel (Slack incoming webhook first; email/SES as a second channel). Explicitly out of scope for v1: traffic-flow correlation (stays `#55`'s job), security-posture/drift scanning (stays `#48`'s job), auto-remediation (stays `#18`'s job — this Worker's alert is v1's hand-off point to a human; auto-invoking `#18`'s Agent from this Worker's alert is a v2 idea, not v1). Cleanest credential story: `aws` only, all read-only (`ec2:DescribeVpnConnections`, `ec2:DescribeRouteTables`, `ec2:DescribeTransitGatewayAttachments`), one `other`-scope webhook URL for alerting. | Payfinia (idea source, PFDO-904 / Sanket) | **Worker** | `aws`, `other` (alert webhook) | generic | Not started |
| 57 | VPN Setup from Excel Intake (Customer Gateway Provisioner) | Sourced from the same PFDO-904 discussion — referenced as "Rohit already built an extension to set up VPN from an Excel input." **2026-09-22 repo sweep found no such extension or script exists** — only the customer-facing intake paperwork: `payfinia/repo/devops/vpn-setup/{OnPoint,iThink}/*.pdf` + `Payfinia-iTHINK AWS_VPN_Customer_Form {PROD,TEST} - 5.19.26.xlsx` (fields: customer gateway IP, BGP ASN, tunnel config), plus a blank template copy in claude-workspace. One PDF is named `...rohit-update iTHink.pdf`, confirming Rohit Singh authored the paperwork process, not code. Distinct *setup* concern from `#56`'s *monitoring* concern — would read an uploaded intake spreadsheet, create the Customer Gateway + VPN Connection + routes, and validate against `#56`'s tunnel-status check once live. Idea-stage only; not scoped for build. | Payfinia (idea source) | **Agent** | `aws` | generic | Not started |

---

## Notes on methodology

- Extension-type assignments follow the SKILL.md decision table strictly: LLM/open-ended reasoning → Agent;
  deterministic compute or reconcile-with-retry → Worker (confirmed `IScopeClientFactory`/`IScopeCredentials` give
  Worker-mode code direct scope access — it isn't limited to pure compute); one synchronous external object →
  Passthrough; observe-only/on-demand → No-provision.
- Items built only from "notes" or a single validated ask (not working code) are `greenfield` even where the idea
  itself is clear, per your tier definitions.
- The Incent AI Helpdesk skills (`incent-*`, `duplo-*`, `k8s-troubleshooting`) are prompt-based Q&A skills today,
  not resource-shaped — converting them to typed extensions means inventing a resource lifecycle around each,
  which is why several sit in Tier 2 rather than Tier 1 despite the skill content already existing.
- `Classification` (generic vs customer-specific) is judged on whether the *mechanism* has hardcoded business
  logic, not on how the source artifact was named — e.g. #38's RTP cert rotator is the same "rotate a k8s Secret
  safely" shape as #35's Anjuna cert rotator, but is classified customer-specific because the artifact itself is
  wired to TCH/RTP naming, while #35 rotates a generically-named webhook cert.
