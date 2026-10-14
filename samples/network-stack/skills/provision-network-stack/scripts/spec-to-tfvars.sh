#!/usr/bin/env bash
# spec-to-tfvars.sh — map the expanded spec (shared/network-stack.json) to terraform variables.
# Writes $TFROOT/stack.tfvars.json. Called by tf-run.sh with TFROOT exported.
set -euo pipefail

# Same default as tf-run.sh so the script also works standalone from the ticket workdir.
SPEC="${SPEC_FILE:-shared/network-stack.json}"
[ -f "$SPEC" ] || { echo "spec file '$SPEC' not found — run from the ticket workdir or export SPEC_FILE" >&2; exit 1; }
: "${TFROOT:?TFROOT unset}"

jq '{
  name:     .name,
  region:   .spec.region,
  vpc_cidr: .spec.vpcCidr,
  enable_dns_hostnames: (.spec.enableDnsHostnames // true),
  subnets:  [ (.spec.subnets // [])[] | { name: .name, cidr: .cidr, az: (.az // null) } ],
  tags:     (.spec.tags // {})
}' "$SPEC" > "$TFROOT/stack.tfvars.json"
