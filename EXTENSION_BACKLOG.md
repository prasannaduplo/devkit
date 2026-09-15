# Extension Backlog

Trackable backlog of DuploCloud devkit extensions derivable from Prasanna's past customer automation.
Owner: `prasannaduplo`. Generated 2026-08-17 against this repo's architecture
([docs/architecture.md](docs/architecture.md), [.claude/skills/duplo-extension-dev/SKILL.md](.claude/skills/duplo-extension-dev/SKILL.md)).

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

Ranked within each tier by (a) closeness of the existing artifact to a shipped extension and (b) fit with this
repo's supported types/scopes. Rows flagged **NEW GROUND** need something this dev-kit doesn't have a sample for
yet (a custom `other`-scope integration, or a remote-execution channel onto a Windows guest OS that no sample
covers).

## Your three flagged priorities

1. **Anjuna Confidential Computing Integration** (#21) — `needs build-out`, target **Agent**. Good BD angle stays
   intact regardless of extension type.
2. **Anjuna Upgrade Manager** (#22) — `needs build-out`, target **Worker**. Deliberately split from #21 (version
   rollout is deterministic reconcile, not open-ended reasoning) — ship it as its own extension, not a mode of #21.
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
base-image generator** (guru/liftoff/questce pattern) has zero new-ground risk — it's a Dockerfile/entrypoint
pattern proven identically across three customers already, needs no remote-exec channel, and is a clean
Passthrough. Ship that first, then tackle #23 once the SSM/WinRM seam is validated.

### New-ground flags across the whole list

- **Windows remote-execution** (no sample) — #14, #23, #24, #25.
- **Jira via `other` scope** (no sample, pattern only) — #30.
- **Slack via `other` scope** (no sample, pattern only) — notification piece of #6.

---

## Tier 1 — reuse-ready

| # | Extension idea | Source artifact(s) | Customer | Target type | Scope(s) | Status |
|---|---|---|---|---|---|---|
| 1 | Azure RBAC Audit & Remediation Suite | `phase1a-audit.sh`, `phase1a-owner-review.sh`, `phase1a-tempadmin-removal.sh`, `phase1a-developers-group-remediation.sh` | Incent | **Agent** | `azure` | Not started |
| 2 | Cost Management Reporting Pipeline | `azure-cost-report.py`, `aws-cost-estimator.py`, `azure-resource-inventory.py`, `azure_sql_trend.py` (+ pytest suite) | Incent | **Worker** | `azure`, `aws` | Not started |
| 3 | Migration Plan Generator | `incent-migration-planner` helpdesk skill | Incent | **Agent** | `azure`, `aws` | Not started |
| 4 | Customer/Engagement Tracker | `incent-customer-tracker` helpdesk skill | Incent | **No-provision** | — | Not started |
| 5 | Containerization Readiness Assistant | `incent-containerization` helpdesk skill | Incent | **Agent** | `azure`/`aws` (target-dependent) | Not started |
| 6 | EKS/ASG Instance Scheduler ("Sleepy Environments") | `Automation-StartStop/` — `scripts/manage.sh`, per-app scripts, `config/inventory.json`, S3 state save/restore | Payfinia | **Worker** | `aws`, `kubernetes` | Not started |
| 7 | Staged Canary Prod Promotion | `skills/paze-prod-deploy/SKILL.md` (nonprod→cat01→prod, approval gates) | Payfinia | **Agent** | `aws`, `kubernetes` | Not started |
| 8 | Self-Hosted GitHub Runner Fleet Manager | `custom-runner/duplo-runner-bootstrap.sh`, `duplo-runner-status.sh` | Payfinia | **Worker** | `github`, `aws` | Not started |
| 9 | MGN/Relay IAM Bootstrapper | `vmware-migration/scripts/mgn-agent-iam-setup.sh`, `relay-vm-iam-setup.sh` | MoreThanRewards | **Passthrough** | `aws` | Not started |
| 10 | Multi-Cloud Customer Bootstrapper | `skills/multi-cloud-customer-bootstrap/` (full skill package) | duplocloud internal | **Agent** | `aws`, `azure`, `gcp` | Not started |
| 11 | Azure Cross-Subscription Image Sharer | `azure/container-image-sharing.sh` | duplocloud internal | **Passthrough** | `azure` | Not started |
| 12 | Tenant GitHub Workflow Dispatcher | `githubworkflow-runs/github-workflow-run-script` (curated `gh workflow run` per tenant/repo) | clientsavvy | **Passthrough** | `github` | Not started |
| 13 | Windows/IIS Base-Image Generator | Near-identical Dockerfile + `entrypoint.ps1` pattern across guru/liftoff/questce | guru/liftoff/questce | **Passthrough** | `aws` (ECR) or `azure`/`gcp` | Not started |

## Tier 2 — needs build-out

| # | Extension idea | Source artifact(s) | Customer | Target type | Scope(s) | Status |
|---|---|---|---|---|---|---|
| 14 | Windows SQL Connectivity Doctor 🚩 **NEW GROUND** | `sql-connection/windows-sql-troubleshoot.ps1` | Incent | **Agent** | `aws`/`azure` + Windows remote-exec | Not started |
| 15 | Generic Helpdesk Skill-Pack → Extension Conversion | `duplo-aws-infra`, `duplo-dashboard`, `duplo-project-management`, `k8s-troubleshooting` skills | Incent | **Agent** | `aws`, `kubernetes` | Not started |
| 16 | FedNow OpenSearch Alert Consolidator | `fednow-alerts-opensearch/create_consolidated_monitors.py` + `monitor-payloads/` (214→~20 monitors) | Payfinia | **Worker** | `aws` | Not started |
| 17 | RTP Alert Definition Manager | `rtp-alerts/` — Fluent Bit config + CloudWatch/OpenSearch alert defs | Payfinia | **Worker** | `aws` | Not started |
| 18 | VPN/TGW Connectivity Doctor | `pfdo-1060-achieva-prod-vpn-issue/scripts/` (reactive route-fix scripts; root cause was missing TGW route + shared route table) | Payfinia | **Agent** | `aws` | Not started |
| 19 | NLB Targetless Auto-Heal ⭐ high value, low new-ground risk | Known recurring platform bug + full diagnostic recipe (`aws autoscaling attach-load-balancer-target-groups` fix) | Payfinia | **Worker** | `aws` | Not started |
| 20 | Node Group Right-Sizer | `pfdo-1040-increase-node-group/` (planning notes) | Payfinia | **Worker** | `aws`, `kubernetes` | Not started |
| 21 | **Anjuna Confidential Computing Integration** 🎯 priority | `anjuna-k8s.sh`, `build-/export-anjuna-docker-images.sh`, `generate-webhook-tls-cert.sh`, Terraform for Nitro EKS | Payfinia (anjuna) | **Agent** | `aws`, `kubernetes` | Not started |
| 22 | **Anjuna Upgrade Manager** 🎯 priority | `anjuna/scriptlib/` version helpers | Payfinia (anjuna) | **Worker** | `aws`, `kubernetes` | Not started |
| 23 | **Legacy Windows Discovery & Migration Assistant** 🎯 priority · 🚩 **NEW GROUND** | Full VM/IIS/AD/SQL discovery methodology, OS-era routing, `collect-vm-inventory.bat`, `network-bandwidth-test.ps1`, AWS Transform reports | MoreThanRewards | **Agent** | `aws` + Windows remote-exec | Not started |
| 24 | SQL Server Backup/Restore-to-S3 Scheduler 🚩 **NEW GROUND** | `mssql10-backup-to-s3.ps1` / restore | MoreThanRewards | **Worker** | `aws` + Windows remote-exec | Not started |
| 25 | AD Extract/Restore-to-FSx Scheduler 🚩 **NEW GROUND** | `ad1-extract-to-s3.ps1`, `restore-to-fsx.ps1` | MoreThanRewards | **Worker** | `aws` + Windows remote-exec | Not started |
| 26 | Cutover File Relay (continuous sync) | `relay-generic/` — `watch-and-ingest` + `source-package-and-push` | MoreThanRewards | **Worker** | `aws` | Not started |
| 27 | Azure VM Patch-Mode Enforcer | Single validated ask: enforce `patchMode=AutomaticByPlatform` (no native Terraform-provider hook) | bplogix | **Passthrough** | `azure` | Not started |

## Tier 3 — greenfield

| # | Extension idea | Source artifact(s) | Customer | Target type | Scope(s) | Status |
|---|---|---|---|---|---|---|
| 28 | Incident Runbook Knowledge Base | One-off incident folders (nginx, nexus, ssh, mysql) — individually not reusable, collectively a KB | Payfinia | **No-provision** | — | Not started |
| 29 | IBM MQ Helm Tuning Advisor | `mqclusterbackup/` Helm value tuning notes | Payfinia | **Worker** | `kubernetes` | Not started |
| 30 | Jira Ticket-Scoping Assistant 🚩 **NEW GROUND** | `jira-ticket-analysis/` manual notes | Incent | **Agent** | `other` (Jira, no sample) | Not started |
| 31 | Release Strategy Orchestrator | `release-process/release-strategy-plan.md` + `terraform-k8s-master.zip` | clientsavvy | **Agent** | `gcp`, `kubernetes` | Not started |
| 32 | Cross-Cloud DB Migration Runbook Automator | `database-migration/` — EC2 SQL Server → GCS → Cloud SQL runbook (docs only) | clientsavvy | **Agent** | `gcp`, `aws` | Not started |
| 33 | AWS Transform Plan Importer | AWS Transform-generated migration plan reports | MoreThanRewards | **No-provision** | `aws` | Not started |
| 34 | Internal Ops Playbook Pack | `helpdeskv2/scope` + `vm-update/steps` notes | duplocloud internal | **No-provision** | — | Not started |

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
