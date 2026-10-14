# Cloudflare — Workers Watch

Watches a Cloudflare account's **Workers**: what exists, which deployment is live, and every change since the watch
started (new Workers, deleted Workers, deployments with author, source and message). It is read-only against
Cloudflare. This is v1 of backlog item #58 (`EXTENSION_BACKLOG.md`). It came from MoreThanRewards, who ship
AI-generated code to Workers while their human-built apps run on AWS under DuploCloud.

| | |
|---|---|
| Resource | `CloudflareWatch` — REST `…/environment/extensions/cloudflare-watches`, collection `extension_cloudflarewatch` |
| Mode | **Worker** (`NoSkillsFallbackMode => Worker`; no skills) |
| Cadence | `DriftCadence` = 5 min (`CloudflareWatchWorker`) |
| Scope | one `other`-category scope (Cloudflare) |
| Menu | **Cloudflare → Workers Watch** |

## Scope convention (register once per Cloudflare account)

1. **Cloudflare:** create an **account-owned** API token (Manage Account → Account API Tokens). Give it these
   permissions:
   - Account → **Workers Scripts: Read** (required)
   - Account → **Account Settings: Read** (useful for future audit-log attribution)

   Use separate tokens for read and future write (v2 governed deploy).
2. **DuploCloud → Admin → Providers:** set the type to **Other**. Set the Account Id to
   `https://api.cloudflare.com/client/v4`; it is used as the API base URL, and anything that isn't a URL falls back to
   it. Give it a credential with these keys:
   - `accountId`: the Cloudflare account ID (from the dashboard URL)
   - `apiToken`: the token, marked **sensitive**

   Keys are matched ignoring case, `_` and `-`. `api_token` and `ACCOUNT_ID` also work.
3. Create a scope on that provider and attach it to the workspace. Keep it separate from any scope that carries the
   Cloudflare **MCP server** for AI HelpDesk, because MCP-bound scopes aren't written to `other_scopes/`
   (reference/07).

On save, `ValidateSpecAsync` rejects a scope that is not category `other` or is missing either key. The response is a
400 that names the missing key and never its value. The worker then calls `tokens/verify`. If the token is not
`active`, the row fails with that status.

## What a scan does

| Call | When |
|---|---|
| `GET /accounts/{id}/tokens/verify` | Apply only (create / spec edit) |
| `GET /accounts/{id}/workers/scripts` | every scan |
| `GET /accounts/{id}/workers/scripts/{name}/deployments` | only for new scripts or scripts whose `modified_on` moved; at most 50 per tick, the rest roll to the next tick |

- **Baseline:** the first scan, or a scan after the script filter changes, records state without events. Workers that
  already exist are not treated as changes.
- **Events:** `ScriptAdded`, `ScriptDeleted`, and `Deployed`, with one event per new deployment, so two deploys
  inside one window both appear. They are stored newest first in `Result.Events`, capped at `HistoryLimit` (default
  200, max 1000). Running totals are in `Result.EventCounts`.
- **Author:** `author_email`, else the `workers/triggered_by` annotation. **Message:** the `workers/message`
  annotation (`wrangler deploy --message`).
- **Errors:** a failed periodic scan sets `Result.LastError` and leaves the row `Complete`, so a Cloudflare outage
  doesn't flap status. Only a failed Apply, such as a bad token, fails the row.
- **Rate limit:** on a 429 it honours `Retry-After` once, waiting 1–30 s, then gives up until the next tick. Ticks stay
  well inside the platform's ~97 s worker budget.
- **Delete:** no-op in Cloudflare.

## Layout

```
backend/CloudflareWatch.cs          Spec / Result / entity / hooks / service (validation, Worker mode)
backend/CloudflareWatchController.cs
backend/CloudflareWatchWorker.cs    ApplyAsync (verify + scan) · VerifyDriftAsync (rescan) · no-op delete
backend/CloudflareExtension.cs      AddHostedService<CloudflareWatchWorker>
backend/Cloudflare/                 SDK-free core: client, models, credentials, WorkerDiff, RateLimit
tests/                              xunit tests over backend/Cloudflare (linked files, canned JSON in fixtures/)
frontend/                           Angular 22 remote: list · add/edit (scope picker) · detail (Overview/Workers/Activity)
```

## Tests

The tests have no SDK dependency, because the logic lives in `backend/Cloudflare/` and is compiled into the test
project as linked files. Run them with the builder image's .NET 8 SDK:

```bash
docker run --rm -v "$PWD/extensions/cloudflare":/w -w /w/tests \
  quay.io/duplocloud/duplo-extension-builder:latest dotnet test --nologo
```

## Build / deploy

```bash
./scripts/build-extension.sh  extensions/cloudflare
./scripts/deploy-extension.sh extensions/cloudflare/dist/extension.zip
```

Bump `manifest.json` `version` before reloading changed backend code. Notes:
- **`[AccessControl]`** is omitted from the controller because helpdesk-dev01 runs SDK 1.0.6, which predates it. Add
  it back on newer hosts (reference/18).
- **The Workers deployments API** is newest first. Version metadata and annotations are read as Cloudflare returns
  them; a field missing for a given trigger shows as `—`.

## Roadmap (#58)

- **v2:** governed `wrangler deploy` (Agent mode). The skill pulls the source, runs a dry run, an LLM summarises the
  risk, and a human approves before the deploy runs.
- **Later:**
  - error-rate spikes (GraphQL `workersInvocationsAdaptive`)
  - zone DNS / SSL-mode checks (MTR's proxied records to APPSRV1)
  - Slack alerts (port prd-mgmt-extension `SlackAccess`)
