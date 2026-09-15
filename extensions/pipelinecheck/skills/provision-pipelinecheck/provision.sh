#!/usr/bin/env bash
set -euo pipefail

# Provisions a Pipeline Check resource: read firstName + lastName from the spec the platform wrote to
# shared/pipeline-check.json, combine into fullName, and write it back via the resource's OWN REST route.
# Status and results are two separate APIs.

SPEC_FILE="shared/pipeline-check.json"

WORKSPACE_ID=$(jq -r '.ownerWorkspaceId' "$SPEC_FILE")
ID=$(jq -r '.id' "$SPEC_FILE")
FIRST=$(jq -r '.spec.firstName // ""' "$SPEC_FILE")
LAST=$(jq -r '.spec.lastName // ""' "$SPEC_FILE")

BASE="${DUPLO_BASE:-$DUPLO_HOST}"
RES="$BASE/v1/aiservicedesk/user/data/workspaces/$WORKSPACE_ID/environment/extensions/pipelinechecks/$ID"

auth=(-H "Authorization: Bearer $DUPLO_TOKEN" -H "Content-Type: application/json")

# 1. Report progress
curl -fsS -X POST "$RES/status" "${auth[@]}" \
  -d '{"status":"Processing","subStatus":"Generating full name"}'

# 2. Compute (trim surrounding whitespace)
FULL_NAME="$(echo "$FIRST $LAST" | xargs)"

# 3. Write the result — the body IS the typed PipelineCheckResult object
curl -fsS -X POST "$RES/results" "${auth[@]}" \
  -d "$(jq -nc --arg fn "$FULL_NAME" '{fullName:$fn}')"

# 4. Complete
curl -fsS -X POST "$RES/status" "${auth[@]}" \
  -d '{"status":"Complete","subStatus":"Full name generated"}'

echo "Done: $FULL_NAME"
