# Network Map (netmap)

Read-only network visibility for DuploCloud. v1 adds **Network Blueprints**: a purpose plus a hand-picked set of
VPCs from any mix of AWS scopes and regions. Each scan collects every related resource (routes, NAT/IGW, Transit
Gateways and their route tables, site-to-site VPNs, peering, endpoints, Network Firewall, load balancers, DNS,
flow-log configuration, tags) into a normalized graph, stored as a versioned snapshot.

Nothing is ever created or changed in a cloud account.

## Layout

```
backend/Core/                   SDK-free, unit-tested: graph model, sanitizer, codec, merger, planner,
                                budgeted scan engine, AWS normalizers + fetchers, evaluators, finalizer
backend/NetworkBlueprint.cs     resource + service (validation, picker, snapshot reads)
backend/NetworkSnapshot.cs      hidden per-scan resource
backend/NetworkBlueprintWorker.cs  staged scans (Apply starts/queues; VerifyDrift every minute collects)
backend/NetworkBlueprintController.cs  picker + snapshot endpoints
tests/                          xunit over backend/Core (linked files); fixtures/generated = synthetic only
```

## API

Base: `/v1/aiservicedesk/user/data/workspaces/{ws}/environment/extensions/networkblueprints`

| Method | Path | Purpose |
|---|---|---|
| POST | `` | Create `{ name, spec: { purpose, labels, members: [{ scopeId, region, networkId }] } }` - starts (or queues) scan #1 |
| PATCH | `{id}` | Send the **full spec** (see Behaviour notes). New `scanRequestedAt` = Scan now; changed `members` rescans; label/purpose-only edits don't |
| DELETE | `{id}` | Deletes the blueprint and its snapshots |
| GET | `picker/regions?scopeId=` | Regions for a scope |
| GET | `picker/vpcs?scopeId=&region=` | VPCs for the picker |
| GET | `{id}/snapshots` | Snapshot headers with per-unit status |
| GET | `{id}/snapshots/{snapshotId\|latest}/graph?raw=&encoding=` | The normalized graph (an `unchanged` snapshot follows `sameAsSnapshotId`). `raw=all` (default) \| `routing` (raw only on network ACLs and security groups, what path tracing reads) \| `none`. `encoding=json` (default) \| `gzip64` → `{ encoding: "gzip-base64", data }` (the platform proxy does not compress). The UI sends `raw=routing&encoding=gzip64` |
| GET | `{id}/snapshots/{snapshotId\|latest}/nodes/raw?nodeId=` | `{ nodeId, raw }` for one node (404 if absent); the side panel's Raw section loads it on demand |

Snapshots are hidden resources: they cannot be deprovisioned directly through the API, only with their blueprint.

## Behaviour notes

- Blueprint create/edit and the picker require a user request context; scope membership is verified with the platform's ScopeHelper and fails closed if it is unavailable.
- **PATCH replaces the whole spec on this platform.** A partial spec is not merged and fails validation
  ("Add at least one network to the blueprint."). Always send the full spec: "Scan now" = the full spec with a new
  `scanRequestedAt`; a label edit = the full spec with new `labels`. Member changes rescan; label/purpose-only
  edits do not.
- **Collection runs only on the worker's 1-minute drift ticks.** Create/edit just starts a scan or queues one (if a
  scan is already running, the running scan finishes with its frozen members and the change is picked up
  afterwards). Each tick works through pending units within a 60 s budget (85 s hard cap per unit; a unit that
  cannot finish fails after 3 attempts with "timed out"). Finalize is idempotent and an interrupted finalize is
  adopted on the next tick. If the current members differ from the last scanned set, a rescan is queued
  automatically (self-healing).
- **Progress and results.** While scanning, progress is in `result.activeScan`
  (`unitsFinished` / `unitsTotal` / `currentUnit`), not in `subStatus` (which may be empty). The final state is in
  `result.latestSummary`, `result.memberStatuses` and `result.lastError`. Expect `unitsFinished` to stay 0 for the
  first poll(s) of a scan.
- **Snapshot statuses:** `running`, `complete`, `partial`, `failed`, `unchanged` (same content as the previous
  non-failed snapshot; the graph is not stored and `sameAsSnapshotId` points at it). The snapshot list additionally
  reports `abandoned` for orphaned `running` rows that are no longer the blueprint's active scan. The last 20
  snapshots keep their graph; older ones keep header and summary only.
- **Degraded optional sub-fetches.** Network Firewall, Classic ELB, managed prefix lists, per-VPC Route53 private
  zone lookups and Transit Gateway route tables the scope does not own do not fail the unit. A failure becomes a
  `warning: ...` line in `latestSummary.unitProblems` and the rest of the graph still lands.
- **Idle cost.** With no active scan the worker makes no AWS calls. The platform still writes the row's worker
  bookkeeping (row version) once per drift pass, about once a minute.
- **Route53 is pinned to us-east-1** (commercial partition only in v1; GovCloud and China are out of scope).
- Egress classes reported per subnet: `direct`, `via-nat`, `via-private-nat`, `nat-no-igw`, `via-hub`, `via-hub-partial`,
  `via-inspection`, `via-peering`, `via-appliance`, `via-vpn`, `nat-unavailable`, `blackhole`, `unknown`, `isolated`.

## Required read-only IAM permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeRouteTables", "ec2:DescribeNetworkAcls",
      "ec2:DescribeInternetGateways", "ec2:DescribeEgressOnlyInternetGateways", "ec2:DescribeNatGateways",
      "ec2:GetManagedPrefixListEntries", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSecurityGroups",
      "ec2:DescribeSecurityGroupRules", "ec2:DescribeInstances", "ec2:DescribeVpcEndpoints",
      "ec2:DescribeTransitGateways", "ec2:DescribeTransitGatewayAttachments", "ec2:DescribeTransitGatewayRouteTables",
      "ec2:GetTransitGatewayRouteTableAssociations", "ec2:GetTransitGatewayRouteTablePropagations",
      "ec2:SearchTransitGatewayRoutes", "ec2:DescribeTransitGatewayPeeringAttachments",
      "ec2:DescribeVpnGateways", "ec2:DescribeVpnConnections", "ec2:DescribeCustomerGateways",
      "ec2:DescribeVpcPeeringConnections", "ec2:DescribeFlowLogs", "ec2:DescribeRegions",
      "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeListeners",
      "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth",
      "elasticloadbalancing:DescribeTags",
      "network-firewall:ListFirewalls", "network-firewall:DescribeFirewall",
      "route53:ListHostedZones", "route53:ListHostedZonesByVPC", "route53:ListResourceRecordSets",
      "route53resolver:ListResolverEndpoints", "route53resolver:ListResolverRules",
      "route53resolver:ListResolverRuleAssociations", "route53resolver:ListResolverQueryLogConfigAssociations"
    ],
    "Resource": "*"
  }]
}
```

A missing permission never fails the whole scan: that collector is marked `denied`, its capabilities show
`not-readable` with the exact permission, and everything else still lands.

## Tests

```bash
docker run --rm -v "$PWD/extensions/netmap":/w -w /w/tests \
  quay.io/duplocloud/duplo-extension-builder:latest dotnet test --nologo
```

## Build / deploy

```bash
./scripts/build-extension.sh  extensions/netmap
./scripts/deploy-extension.sh extensions/netmap/dist/extension.zip
```
Bump `manifest.json` `version` before reloading changed backend code. `[AccessControl]` is omitted because
hosts on SDK 1.0.6 predate it.
