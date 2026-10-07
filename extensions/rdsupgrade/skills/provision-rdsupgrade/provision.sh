#!/usr/bin/env bash
set -uo pipefail

# Provisions an RdsUpgrade resource: upgrades an RDS instance's major engine version via an AWS
# Blue/Green Deployment. Runs inside a HelpDesk ticket (Agent-mode provisioning) rather than as a
# background Worker -- see RdsUpgrade.cs's header comment for why (a Worker-mode ApplyAsync tick gets
# cancelled by the platform after ~97s, confirmed via CloudTrail; AWS Blue/Green needs 10-20+ minutes).
#
# Mirrors the phase sequence the v1 Worker used: Prechecking -> Snapshotting -> CreatingParamGroup ->
# CreatingBlueGreen -> ValidatingGreen -> CuttingOver -> PostVerify -> CleaningUp -> Completed.

SPEC_FILE="shared/rds-upgrade.json"
STEPS_FILE="$(mktemp)"
echo '[]' > "$STEPS_FILE"

WORKSPACE_ID=$(jq -r '.ownerWorkspaceId' "$SPEC_FILE")
ID=$(jq -r '.id' "$SPEC_FILE")
DB_INSTANCE_ID=$(jq -r '.spec.dbInstanceIdentifier' "$SPEC_FILE")
REGION=$(jq -r '.spec.region' "$SPEC_FILE")
TARGET_ENGINE_VERSION=$(jq -r '.spec.targetEngineVersion' "$SPEC_FILE")
TARGET_INSTANCE_CLASS=$(jq -r '.spec.targetInstanceClass // empty' "$SPEC_FILE")
TARGET_PARAM_GROUP_SPEC=$(jq -r '.spec.targetParameterGroupName // empty' "$SPEC_FILE")
SWITCHOVER_TIMEOUT_MIN=$(jq -r '.spec.switchoverTimeoutMinutes // 5' "$SPEC_FILE")

BASE="${DUPLO_BASE:-$DUPLO_HOST}"
RES="$BASE/v1/aiservicedesk/user/data/workspaces/$WORKSPACE_ID/environment/extensions/rdsupgrades/$ID"
auth=(-H "Authorization: Bearer $DUPLO_TOKEN" -H "Content-Type: application/json")

# Resumability: this script can be invoked more than once for the same resource (the agent may retry
# after an error, same risk the old Worker-mode version hit from the platform's own retry loop). Seed
# all progress state from whatever is already persisted, so a second invocation resumes instead of
# starting blank, conflicting with its own prior work, and overwriting good history with a thin failure.
#
# This is entirely best-effort and MUST NOT be fatal: the ticket's token is scoped only to .../status
# and .../results (confirmed -- a plain GET on the bare resource returns 401/403, which crashed every
# Prechecking attempt with a useless generic error until this was caught). A brand-new resource also has
# nothing to resume from yet, which is a normal, non-error case, not a failure.
SNAPSHOT_ID=""
PARAM_GROUP_NAME=""
BG_DEPLOYMENT_ID=""
GREEN_INSTANCE_ID=""
GREEN_ENDPOINT=""
EXISTING_RESULT=$(curl -fsS "$RES/results" "${auth[@]}" 2>/dev/null | jq -c 'if has("data") then .data else . end' 2>/dev/null) || EXISTING_RESULT=""
if [ -n "$EXISTING_RESULT" ] && echo "$EXISTING_RESULT" | jq -e . >/dev/null 2>&1; then
  SNAPSHOT_ID=$(echo "$EXISTING_RESULT" | jq -r '.snapshotIdentifier // empty')
  PARAM_GROUP_NAME=$(echo "$EXISTING_RESULT" | jq -r '.parameterGroupName // empty')
  BG_DEPLOYMENT_ID=$(echo "$EXISTING_RESULT" | jq -r '.blueGreenDeploymentId // empty')
  GREEN_INSTANCE_ID=$(echo "$EXISTING_RESULT" | jq -r '.greenInstanceIdentifier // empty')
  GREEN_ENDPOINT=$(echo "$EXISTING_RESULT" | jq -r '.greenEndpoint // empty')
else
  EXISTING_RESULT="{}"
fi
echo "$EXISTING_RESULT" | jq -c '.stepHistory // []' > "$STEPS_FILE"

# AWS profile: the scope's credentials land in ./.aws/credentials as a named profile. Grab the first
# (only) one, same convention as extensions/terraform's aws-env.sh.
AWS_CREDS_FILE="$(pwd)/.aws/credentials"
if [ ! -f "$AWS_CREDS_FILE" ]; then
  echo "No AWS credentials materialized -- is an AWS scope attached to this resource?" >&2
  exit 1
fi
export AWS_SHARED_CREDENTIALS_FILE="$AWS_CREDS_FILE"
[ -f "$(pwd)/.aws/config" ] && export AWS_CONFIG_FILE="$(pwd)/.aws/config"
export AWS_PROFILE
AWS_PROFILE=$(grep -E '^\[[^]]+\]$' "$AWS_CREDS_FILE" | head -1 | tr -d '[]')
export AWS_DEFAULT_REGION="$REGION"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE

GUARD_ROLE_NAME="duplomaster"
GUARD_POLICY_NAME="rdsupgrade-guard-$ID"
GUARD_ATTACHED=0
BG_DEPLOYMENT_ID=""
SWITCHOVER_DONE=0
CURRENT_PHASE="Requested"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

add_step() {
  local phase="$1" status="$2" message="${3:-}"
  CURRENT_PHASE="$phase"
  local step
  step=$(jq -nc --arg p "$phase" --arg s "$status" --arg m "$message" --arg t "$(now_iso)" \
    '{phase:$p, startedAt:$t, completedAt:$t, status:$s, message:$m}')
  jq --argjson s "$step" '. + [$s]' "$STEPS_FILE" > "$STEPS_FILE.tmp" && mv "$STEPS_FILE.tmp" "$STEPS_FILE"
}

post_status() {
  curl -fsS -X POST "$RES/status" "${auth[@]}" \
    -d "$(jq -nc --arg s "$1" --arg sub "${2:-}" '{status:$s, subStatus:$sub}')" >/dev/null
}

post_status_failed() {
  curl -fsS -X POST "$RES/status" "${auth[@]}" \
    -d "$(jq -nc --arg msg "$1" '{status:"Failed", subStatus:$msg, faults:[$msg]}')" >/dev/null
}

# Posts the current Result snapshot -- called after every phase so the UI's phase tracker updates live,
# and again (with phase=Failed/Completed) at the very end.
post_results() {
  local phase="$1"
  curl -fsS -X POST "$RES/results" "${auth[@]}" -d "$(jq -nc \
    --arg phase "$phase" \
    --argjson steps "$(cat "$STEPS_FILE")" \
    --arg sourceEngine "${SOURCE_ENGINE:-}" \
    --arg sourceEngineVersion "${SOURCE_ENGINE_VERSION:-}" \
    --arg snapshotIdentifier "${SNAPSHOT_ID:-}" \
    --arg parameterGroupName "${PARAM_GROUP_NAME:-}" \
    --arg blueGreenDeploymentId "${BG_DEPLOYMENT_ID:-}" \
    --arg greenInstanceIdentifier "${GREEN_INSTANCE_ID:-}" \
    --arg greenEndpoint "${GREEN_ENDPOINT:-}" \
    --arg oldInstanceIdentifier "${OLD_INSTANCE_ID:-}" \
    --arg finalEndpoint "${FINAL_ENDPOINT:-}" \
    --arg errorMessage "${ERROR_MESSAGE:-}" \
    '{phase:$phase, stepHistory:$steps} +
     ({sourceEngine:$sourceEngine}|if .sourceEngine=="" then {} else . end) +
     ({sourceEngineVersion:$sourceEngineVersion}|if .sourceEngineVersion=="" then {} else . end) +
     ({snapshotIdentifier:$snapshotIdentifier}|if .snapshotIdentifier=="" then {} else . end) +
     ({parameterGroupName:$parameterGroupName}|if .parameterGroupName=="" then {} else . end) +
     ({blueGreenDeploymentId:$blueGreenDeploymentId}|if .blueGreenDeploymentId=="" then {} else . end) +
     ({greenInstanceIdentifier:$greenInstanceIdentifier}|if .greenInstanceIdentifier=="" then {} else . end) +
     ({greenEndpoint:$greenEndpoint}|if .greenEndpoint=="" then {} else . end) +
     ({oldInstanceIdentifier:$oldInstanceIdentifier}|if .oldInstanceIdentifier=="" then {} else . end) +
     ({finalEndpoint:$finalEndpoint}|if .finalEndpoint=="" then {} else . end) +
     ({errorMessage:$errorMessage}|if .errorMessage=="" then {} else . end)')" >/dev/null
}

on_error() {
  local exit_code=$?
  local msg="${ERROR_MESSAGE:-Unexpected failure in phase $CURRENT_PHASE (exit $exit_code)}"
  ERROR_MESSAGE="$msg"
  add_step "Failed" "Failed" "$msg"

  # Best-effort rollback, mirroring the C# worker's catch block.
  if [ "$GUARD_ATTACHED" = "1" ]; then
    aws iam delete-role-policy --role-name "$GUARD_ROLE_NAME" --policy-name "$GUARD_POLICY_NAME" 2>/dev/null || true
  fi
  if [ -n "$BG_DEPLOYMENT_ID" ] && [ "$SWITCHOVER_DONE" = "0" ]; then
    aws rds delete-blue-green-deployment --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" \
      --delete-target 2>/dev/null || true
  fi

  post_results "Failed"
  post_status_failed "$msg"
  exit 1
}
trap on_error ERR

poll_until() {
  # poll_until <timeout_seconds> <description> <command...> -- retries <command> (which should exit 0
  # when the condition is met) every 20s until it succeeds or the timeout elapses.
  local timeout="$1" desc="$2"; shift 2
  local deadline=$(( $(date +%s) + timeout ))
  until "$@"; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
      ERROR_MESSAGE="Timed out waiting: $desc"
      return 1
    fi
    sleep 20
  done
}

# ── Prechecking ──────────────────────────────────────────────────────────
post_status "Processing" "Prechecking"
INSTANCE_JSON=$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0]' --output json)
if [ "$INSTANCE_JSON" = "null" ] || [ -z "$INSTANCE_JSON" ]; then
  ERROR_MESSAGE="RDS instance '$DB_INSTANCE_ID' not found."
  false
fi
SOURCE_ENGINE=$(echo "$INSTANCE_JSON" | jq -r '.Engine')
SOURCE_ENGINE_VERSION=$(echo "$INSTANCE_JSON" | jq -r '.EngineVersion')
SOURCE_ARN=$(echo "$INSTANCE_JSON" | jq -r '.DBInstanceArn')

case "$SOURCE_ENGINE" in
  mysql|postgres|mariadb|aurora-mysql|aurora-postgresql) ;;
  *) ERROR_MESSAGE="Engine '$SOURCE_ENGINE' does not support Blue/Green deployments."; false ;;
esac

# Exclude our own already-tracked deployment (BG_DEPLOYMENT_ID, seeded from the persisted Result above)
# -- that's a resume, not a conflict. Only a genuinely different active deployment blocks us.
EXISTING_BG=$(aws rds describe-blue-green-deployments \
  --query "BlueGreenDeployments[?Source=='$SOURCE_ARN' && Status!='SWITCHOVER_COMPLETED' && BlueGreenDeploymentIdentifier!='${BG_DEPLOYMENT_ID:-__none__}']" --output json)
if [ "$(echo "$EXISTING_BG" | jq 'length')" != "0" ]; then
  ERROR_MESSAGE="'$DB_INSTANCE_ID' already has an active Blue/Green deployment."
  false
fi

add_step "Prechecking" "OK"
post_results "Prechecking"

# ── Snapshotting ─────────────────────────────────────────────────────────
post_status "Processing" "Snapshotting"
if [ -z "$SNAPSHOT_ID" ]; then
  SNAPSHOT_ID="${DB_INSTANCE_ID}-preupgrade-$(date -u +%Y%m%d%H%M%S)"
  aws rds create-db-snapshot --db-instance-identifier "$DB_INSTANCE_ID" \
    --db-snapshot-identifier "$SNAPSHOT_ID" >/dev/null
fi

snapshot_ready() {
  local status pct
  status=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" \
    --query 'DBSnapshots[0].Status' --output text 2>/dev/null)
  pct=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" \
    --query 'DBSnapshots[0].PercentProgress' --output text 2>/dev/null)
  post_status "Processing" "Snapshot: $status (${pct:-0}%)"
  [ "$status" = "available" ]
}
poll_until 1800 "snapshot '$SNAPSHOT_ID' to become available" snapshot_ready

add_step "Snapshotting" "OK" "Snapshot $SNAPSHOT_ID"
post_results "Snapshotting"

# ── CreatingParamGroup ───────────────────────────────────────────────────
post_status "Processing" "CreatingParamGroup"
PARAM_GROUP_DONE=$(jq '[.[] | select(.phase=="CreatingParamGroup" and .status=="OK")] | length > 0' "$STEPS_FILE")
if [ "$PARAM_GROUP_DONE" = "true" ]; then
  add_step "CreatingParamGroup" "OK" "Already completed on a prior attempt."
elif [ -n "$TARGET_PARAM_GROUP_SPEC" ]; then
  PARAM_GROUP_NAME="$TARGET_PARAM_GROUP_SPEC"
  add_step "CreatingParamGroup" "OK" "Using user-supplied parameter group."
else
  SOURCE_GROUP=$(echo "$INSTANCE_JSON" | jq -r \
    '.DBParameterGroups[]? | select(.DBParameterGroupName | startswith("default.")|not) | .DBParameterGroupName' | head -1)
  if [ -z "$SOURCE_GROUP" ]; then
    add_step "CreatingParamGroup" "OK" "Source uses a default group — AWS will assign a default target group."
  else
    NEW_GROUP_NAME="${DB_INSTANCE_ID}-bg-${TARGET_ENGINE_VERSION//./-}"
    aws rds copy-db-parameter-group \
      --source-db-parameter-group-identifier "$SOURCE_GROUP" \
      --target-db-parameter-group-identifier "$NEW_GROUP_NAME" \
      --target-db-parameter-group-description "Cloned from $SOURCE_GROUP for Blue/Green upgrade to $TARGET_ENGINE_VERSION" >/dev/null
    PARAM_GROUP_NAME="$NEW_GROUP_NAME"
    add_step "CreatingParamGroup" "OK" "Cloned $SOURCE_GROUP -> $NEW_GROUP_NAME"
  fi
fi
post_results "CreatingParamGroup"

# ── CreatingBlueGreen ────────────────────────────────────────────────────
post_status "Processing" "CreatingBlueGreen"

RESUMED_BG=0
if [ -n "$BG_DEPLOYMENT_ID" ]; then
  PRIOR_STATUS=$(aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" \
    --query 'BlueGreenDeployments[0].Status' --output text 2>/dev/null || true)
  case "$PRIOR_STATUS" in
    DELETED|INVALID_CONFIGURATION|SWITCHOVER_COMPLETED|""|None) BG_DEPLOYMENT_ID="" ;;
    *) RESUMED_BG=1 ;;
  esac
fi

if [ "$RESUMED_BG" = "1" ]; then
  add_step "CreatingBlueGreen" "OK" "Reused existing deployment $BG_DEPLOYMENT_ID"
else
  BG_NAME="${DB_INSTANCE_ID}-bg"
  CREATE_ARGS=(--blue-green-deployment-name "$BG_NAME" --source "$SOURCE_ARN" --target-engine-version "$TARGET_ENGINE_VERSION")
  [ -n "$TARGET_INSTANCE_CLASS" ] && CREATE_ARGS+=(--target-db-instance-class "$TARGET_INSTANCE_CLASS")
  [ -n "$PARAM_GROUP_NAME" ] && CREATE_ARGS+=(--target-db-parameter-group-name "$PARAM_GROUP_NAME")

  BG_DEPLOYMENT_ID=$(aws rds create-blue-green-deployment "${CREATE_ARGS[@]}" \
    --query 'BlueGreenDeployment.BlueGreenDeploymentIdentifier' --output text)
  add_step "CreatingBlueGreen" "OK" "Deployment $BG_DEPLOYMENT_ID"
fi

GREEN_TARGET_ARN=$(aws rds describe-blue-green-deployments \
  --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" --query 'BlueGreenDeployments[0].Target' --output text)
[ "$GREEN_TARGET_ARN" != "None" ] && GREEN_INSTANCE_ID=$(echo "$GREEN_TARGET_ARN" | sed -E 's/.*://')
post_results "CreatingBlueGreen"

# ── Attach delete-guard (not its own phase -- folded into CreatingBlueGreen's window, matching v1) ──
if [ "$GREEN_TARGET_ARN" != "None" ] && [ -n "$GREEN_TARGET_ARN" ]; then
  POLICY_DOC=$(jq -nc --arg arn "$GREEN_TARGET_ARN" \
    '{Version:"2012-10-17", Statement:[{Effect:"Deny", Action:["rds:DeleteDBInstance","rds:DeleteDBCluster"], Resource:$arn}]}')
  aws iam put-role-policy --role-name "$GUARD_ROLE_NAME" --policy-name "$GUARD_POLICY_NAME" \
    --policy-document "$POLICY_DOC" >/dev/null
  GUARD_ATTACHED=1
  add_step "CreatingBlueGreen" "OK" "Delete-guard attached on $GREEN_TARGET_ARN"
  post_results "CreatingBlueGreen"
fi

# ── ValidatingGreen ──────────────────────────────────────────────────────
post_status "Processing" "ValidatingGreen"
bg_available() {
  local status green_status detail
  status=$(aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" \
    --query 'BlueGreenDeployments[0].Status' --output text 2>/dev/null)
  detail="Blue/Green: $status"
  if [ -n "${GREEN_INSTANCE_ID:-}" ]; then
    green_status=$(aws rds describe-db-instances --db-instance-identifier "$GREEN_INSTANCE_ID" \
      --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null)
    [ -n "$green_status" ] && [ "$green_status" != "None" ] && detail="$detail | Green instance: $green_status"
  fi
  post_status "Processing" "$detail"
  if [ "$status" = "INVALID_CONFIGURATION" ]; then
    ERROR_MESSAGE="Blue/Green deployment '$BG_DEPLOYMENT_ID' reported INVALID_CONFIGURATION."
    return 1
  fi
  [ "$status" = "AVAILABLE" ]
}
poll_until 3600 "Blue/Green deployment '$BG_DEPLOYMENT_ID' to become AVAILABLE" bg_available

if [ -n "${GREEN_INSTANCE_ID:-}" ]; then
  GREEN_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$GREEN_INSTANCE_ID" \
    --query 'DBInstances[0].Endpoint.[Address,Port]' --output text 2>/dev/null | tr '\t' ':')
fi
add_step "ValidatingGreen" "OK" "${GREEN_ENDPOINT:-}"
post_results "ValidatingGreen"

# ── CuttingOver (switchover) ─────────────────────────────────────────────
post_status "Processing" "CuttingOver"
aws rds switchover-blue-green-deployment --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" \
  --switchover-timeout "$((SWITCHOVER_TIMEOUT_MIN * 60))" >/dev/null

switchover_complete() {
  local status
  status=$(aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" \
    --query 'BlueGreenDeployments[0].Status' --output text 2>/dev/null)
  post_status "Processing" "Switchover: $status"
  [ "$status" = "SWITCHOVER_COMPLETED" ]
}
poll_until 1800 "switchover of '$BG_DEPLOYMENT_ID' to complete" switchover_complete
SWITCHOVER_DONE=1
add_step "CuttingOver" "OK"
post_results "CuttingOver"

# ── PostVerify ───────────────────────────────────────────────────────────
post_status "Processing" "PostVerify"
PROD_JSON=$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" --query 'DBInstances[0]' --output json)
PROD_ENGINE_VERSION=$(echo "$PROD_JSON" | jq -r '.EngineVersion')
if [ "$PROD_ENGINE_VERSION" != "$TARGET_ENGINE_VERSION" ]; then
  ERROR_MESSAGE="Post-verify failed: '$DB_INSTANCE_ID' reports engine version $PROD_ENGINE_VERSION, expected $TARGET_ENGINE_VERSION."
  false
fi
FINAL_ENDPOINT=$(echo "$PROD_JSON" | jq -r '.Endpoint | "\(.Address):\(.Port)"')

# After switchover, the source side of the Blue/Green deployment is the renamed old instance.
OLD_SOURCE_ARN=$(aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" \
  --query 'BlueGreenDeployments[0].Source' --output text 2>/dev/null)
[ -n "$OLD_SOURCE_ARN" ] && [ "$OLD_SOURCE_ARN" != "None" ] && OLD_INSTANCE_ID=$(echo "$OLD_SOURCE_ARN" | sed -E 's/.*://')

add_step "PostVerify" "OK" "$FINAL_ENDPOINT"
post_results "PostVerify"

# ── CleaningUp ───────────────────────────────────────────────────────────
post_status "Processing" "CleaningUp"
CLEANUP_NOTES=""
if [ -n "${OLD_INSTANCE_ID:-}" ]; then
  OLD_DEL_ERR=$(aws rds delete-db-instance --db-instance-identifier "$OLD_INSTANCE_ID" --skip-final-snapshot 2>&1 >/dev/null) || \
    CLEANUP_NOTES="$CLEANUP_NOTES Old instance delete failed: $OLD_DEL_ERR."
fi
# --delete-target is a boolean TOGGLE flag in the AWS CLI (present = true), not --delete-target <value>.
# We want the deployment object removed but the (now-production) target kept -- that's --no-delete-target.
BG_DEL_ERR=$(aws rds delete-blue-green-deployment --blue-green-deployment-identifier "$BG_DEPLOYMENT_ID" \
  --no-delete-target 2>&1 >/dev/null) || CLEANUP_NOTES="$CLEANUP_NOTES Blue/Green deployment delete failed: $BG_DEL_ERR."

if [ "$GUARD_ATTACHED" = "1" ]; then
  aws iam delete-role-policy --role-name "$GUARD_ROLE_NAME" --policy-name "$GUARD_POLICY_NAME" 2>/dev/null || true
  GUARD_ATTACHED=0
fi
if [ -n "$CLEANUP_NOTES" ]; then
  add_step "CleaningUp" "Warning" "${CLEANUP_NOTES# }"
else
  add_step "CleaningUp" "OK"
fi
post_results "CleaningUp"

# ── Completed ────────────────────────────────────────────────────────────
post_results "Completed"
post_status "Complete" "RDS upgrade completed."
echo "Done: $DB_INSTANCE_ID upgraded to $TARGET_ENGINE_VERSION, endpoint $FINAL_ENDPOINT"
