# 07 — Reading scope credentials during provisioning

When your resource provisions through the **agent** (HelpdeskAgent mode), the platform writes the credentials of
the scopes selected for that resource onto the **provisioning ticket's working directory** (the agent's `cwd`).
Your provisioning skill reads them from there to call the target system's APIs (AWS, Kubernetes, GitHub, or — for
a custom integration — an arbitrary external HTTP API).

This is the seam that lets an extension talk to an **external system**: register that system as a DuploCloud
**Provider**, put its connection info + secret in a **Credential**, bind it with a **Scope**, attach the scope to
the workspace, and reference it from the resource spec's `ScopeIds`. The agent materializes it to disk; your
skill reads it.

## The path: spec → scope → ticket → files on disk

1. The resource spec carries `ScopeIds: ["<scopeId>", …]` (a field on `BaseSpec`). The user picks the scope(s)
   in the Add form (a scope picker), or your `GetExpandedSpecForAgentAsync` stamps them.
2. On provisioning, the platform expands each scope → its `Provider` → the named `Credential`, and includes them
   in the ticket's `platform_context.scopes[]` (handled by the host; you don't call this).
3. The **agent** (`claude-code-generic-ai-agent`) writes each scope to the ticket `cwd` with a per-provider-type
   writer (`core/agent_setup/scopes/`), and exports env vars pointing CLIs at them.
4. Your skill — running in that `cwd` — reads the file/env for the scope and makes its API calls.

The expanded spec the platform drops at `shared/<subtype>.json` includes the `scopeIds`, so your skill knows
which scope(s) apply.

## Where each provider type lands (relative to the ticket `cwd`)

| Provider type / category | On-disk location | Env var the agent sets | How to use |
|---|---|---|---|
| **AWS** (`aws`) | `.aws/credentials` + `.aws/config` (INI, per-scope profile) | `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_PROFILE` (cleared) | `aws … --profile <scope>` |
| **Kubernetes** (`eks`/`gke`/`aks`/category `kubernetes`) | `.kube/config` (merged) | `KUBECONFIG` | `kubectl --context <ctx> …` |
| **GCP** (`gcp`) | `.gcloud/…` + `.gcp/<name>_token.txt` | `CLOUDSDK_CONFIG` | `gcloud …` / bearer token |
| **Azure** (`azure`) | `.azure-<scope>/` (MSAL cache + profile) | `AZURE_CONFIG_DIR` (first scope) | `AZURE_CONFIG_DIR=.azure-<name> az …` |
| **GitHub** (`github`) | `.config/gh/hosts.yml` | `GH_CONFIG_DIR` | `gh …` |
| **GitLab** (`gitlab`) | `.config/glab-cli/config.yml` | `GLAB_CONFIG_DIR` | `glab …` |
| **Duplo** (`duplo`) | `.duplo/credentials` (INI: `host`/`token` per scope) | — | read the INI; never overwrite `DUPLO_TOKEN`/`DUPLO_HOST` with it |
| **Anything else — category `other`** (a custom / third-party HTTP API, …) | **`other_scopes/<scope-name>.json`** | — | parse JSON, call the API yourself |

Selection for the `other` dump is by ProviderInfo.Type NOT in `{eks, kubernetes, gke, aks, aws, gcp, azure,
github}` — so **`gitlab` and `duplo` scopes land in `other_scopes/<name>.json` IN ADDITION to their own
writers** (the rows are not mutually exclusive). GCP writes BOTH `.gcloud/` (→ `CLOUDSDK_CONFIG`) and `.gcp/`
token files.

The cloud/SCM writers are for first-party CLIs. **Custom external systems use the `other` path** — that's the one
you care about for an extension that talks to a custom external system.

**Kubernetes scope — the agent-skill recipe** (a provisioning skill that kubectl-applies workloads):
the platform materializes the k8s scope as a kubeconfig at `./.kube/config` with `KUBECONFIG` exported; a
single attached cluster IS the current context. In `provision.sh`:

```bash
# Single attached cluster → current-context is it. Fail early if no k8s scope was attached.
CTX=$(kubectl config current-context 2>/dev/null) || fail "no kubernetes context (attach a kubernetes scope)"
# Always pass the context + namespace explicitly; keep every apply idempotent.
kubectl --context "$CTX" get namespace "$NS" >/dev/null 2>&1 || kubectl --context "$CTX" create namespace "$NS"
kubectl --context "$CTX" -n "$NS" apply -f - <<EOF
…manifest…
EOF
```

(Teardown mirrors it with `kubectl --context "$CTX" -n "$NS" delete … --ignore-not-found` — see
[11-deprovisioning](11-deprovisioning.md).) The C#-side k8s client is different plumbing —
`IScopeClientFactory.GetKubernetesClientAsync` ([10-sdk-api](10-sdk-api.md)); worked in
`samples/worker-appstack` and `samples/passthrough-configmap`.

## The `other` (generic) provider — the case for custom integrations

Any scope whose `ProviderInfo.Type` is **not** one of `{eks, kubernetes, gke, aks, aws, gcp, azure, github}`,
whose category is **not** `kubernetes`, and that carries no MCP server, is written verbatim as JSON to:

```
other_scopes/<safe-name>.json      # safe-name = scope Name (or CredentialName); "/" and " " → "_"
```

The file is the **entire expanded scope**. Shape (example — a generic external HTTP API):

```json
{
  "Id": "6a30…",
  "Name": "prod-api",
  "CredentialName": "svc-bot",
  "ProviderInfo": {
    "Type": "other",
    "Category": "other",
    "AccountId": "https://api.example.com",         // conventionally the base URL
    "Name": "External API",
    "Description": "…"
  },
  "Credential": {
    "Name": "svc-bot",
    "Data": {                                       // keys are whatever the provider Credential defined (DataEx)
      "baseUrl": "https://api.example.com",
      "username": "svc-bot",
      "apiToken": "11e9…"
    }
  },
  "ResourceMap": { }                                // optional allow-list the admin set on the scope
}
```

> The keys under `Credential.Data` are exactly the `DataEx` keys the admin entered when creating the provider
> credential. There is no fixed schema — your extension defines the convention (document it in your skill).
> By convention the base URL is in `ProviderInfo.AccountId`; you may also duplicate it in `Credential.Data`.

### Read it from a skill (keep secrets out of stdout)

Use `jq` inline so tokens never print:

```bash
# Pick the scope: correlate to the spec's scopeId (robust), or match by category if you didn't define a type.
SID=$(jq -r '.scopeIds[0]' shared/<subtype>.json)
SFILE=$(grep -rl "\"Id\": *\"$SID\"" other_scopes/ 2>/dev/null | head -1)
# or, match by category:  SFILE=$(grep -rl '"Category": *"other"' other_scopes/ | head -1)

API_URL=$(jq -r '.ProviderInfo.AccountId // .Credential.Data.baseUrl' "$SFILE")
API_USER=$(jq -r '.Credential.Data.username' "$SFILE")

# Call the API without ever echoing the token (process-substitution feeds curl's -u):
curl -fsS -u "$API_USER:$(jq -r '.Credential.Data.apiToken' "$SFILE")" \
  "$API_URL/api/v1/things"
```

Python:

```python
import json, glob
sid = json.load(open("shared/<subtype>.json"))["scopeIds"][0]
scope = next(
    s for p in glob.glob("other_scopes/*.json")
    if (s := json.load(open(p)))["Id"] == sid
)
base = scope["ProviderInfo"]["AccountId"]
auth = (scope["Credential"]["Data"]["username"], scope["Credential"]["Data"]["apiToken"])
# requests.get(f"{base}/api/v1/things", auth=auth)
```

> `curl` gotcha: if the API URL contains `[` or `]` (e.g. a `?filter=items[0],meta[...]` query), pass
> **`curl -g`** to disable URL globbing — otherwise curl treats the brackets as a glob range and the request fails.

**Runtime facts:** `platform_context` (scopes/skills/secrets) is stamped onto
EVERY message on the wire — it is never written to disk as a file; on disk you get the credential files
above. Ticket secrets additionally arrive as `DUPLO_SECRET_<NAME>` env vars + `secrets/secrets.json` (0600).
Credential files are **wiped at the end of every agent turn** and re-materialized on the next message. Use
`$TMPDIR` (the ticket's `tmp/`) for cross-call scratch — `/tmp` is a PRIVATE tmpfs per bash invocation.
Never overwrite these env vars in a skill: `DUPLO_TOKEN`, `DUPLO_HOST`, `TF_APPEND_USER_AGENT`,
`AWS_EXECUTION_ENV`, `CLOUDSDK_METRICS_ENVIRONMENT` (partner attribution).

The agent also injects an **"## Additional Scopes"** section into its own system prompt that lists each
`other_scopes/*.json` file and its key tree — so the agent already knows the files exist. Your skill should still
spell out which scope/keys it needs and the exact API calls to make.

## Registering the provider (one-time, outside the extension)

The extension consumes credentials; an operator supplies them via the admin API (or UI):

1. **Provider** — `POST /v1/aiservicedesk/admin/data/providers` with `type` (`"other"`; category `other`),
   `accountId` = base URL, and a `credentials[]` entry whose `dataEx` holds `baseUrl` / `username` / `apiToken`
   (mark the token `isSensitive: true`).
2. **Scope** — `POST …/admin/data/scopes` with `providerId` + `credentialName` (+ optional `resourceMap`).
3. **Attach** the scope id to the workspace (`…/admin/data/workspaces/{id}` `scopeIds`).
4. The resource's Add form lets the user select that scope → it lands in `spec.ScopeIds`.

> Provider `type` strings are whitelisted in the host (`Duplo.Ai.DataManagement/…/Services/ProviderService.cs`
> `validTypes`). `"other"` is always allowed and needs no host change — use it for custom integrations. (A
> dedicated type string would need a one-line host whitelist add, which an extension can't do at runtime.)

## Checklist for an external-API extension
- [ ] Spec includes `ScopeIds` and the Add form shows a scope picker.
- [ ] `GetExpandedSpecForAgentAsync` includes the scope id(s) in `shared/<subtype>.json` (so the skill can
      correlate), or the skill selects by `ProviderInfo.Type`.
- [ ] The skill reads `other_scopes/<name>.json`, never prints the token, and calls the API with basic/bearer auth.
- [ ] On auth/connectivity failure the skill posts `status: Failed` with a clear `faults[]` message.

See also: [08-parent-child-and-menus](08-parent-child-and-menus.md) (multi-resource), and
[05-custom-actions](05-custom-actions.md) (calling the same external API from a custom controller endpoint for
live data / actions in the FE).
