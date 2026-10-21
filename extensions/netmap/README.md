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
| GET | `picker/k8s?scopeId=&region=` | **v2b spike, diagnostic.** Per EKS cluster in the region (max 20): version, status, endpoint host, public/private access + CIDRs, authenticationMode, the scope's callerArn (session name redacted), whether the API answers (`apiReachable`, `apiVersion`), whether the identity can list pods / services / networkpolicies cluster-wide, `httpStatus` and a short `message`. Never returns the token |
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
      "route53resolver:ListResolverRuleAssociations", "route53resolver:ListResolverQueryLogConfigAssociations",
      "eks:ListClusters", "eks:DescribeCluster", "sts:GetCallerIdentity",
      "ecs:ListClusters", "ecs:DescribeClusters", "ecs:ListServices", "ecs:DescribeServices",
      "ecs:ListTasks", "ecs:DescribeTasks",
      "lambda:ListFunctions"
    ],
    "Resource": "*"
  }]
}
```

A missing permission never fails the whole scan: that collector is marked `denied`, its capabilities show
`not-readable` with the exact permission, and everything else still lands.

### Workloads (v2b): EKS, ECS, Lambda

Three regional collectors run after interfaces and load balancers, so they can link to the ENIs and LBs already
collected (capability tile **Workloads**):

- `aws.eks` — `eks:ListClusters` (at most 20 per region) + `eks:DescribeCluster`; only clusters whose VPC is a
  member network. For each, read-only Kubernetes LIST calls with the EKS bearer token (below), TLS pinned to the
  cluster CA, paginated 500 at a time: namespaces, pods (at most 3000 per cluster; truncation is reported as a
  warning and on the cluster node), services, ingresses (`networking.k8s.io/v1`), networkpolicies and nodes.
  **Never Secrets or ConfigMaps.** Stored per pod: name, namespace, labels (20, plus any a selector uses), pod IPs,
  phase, node, owner (Deployment from its ReplicaSet), container names + images — no env, command, volumes or raw.
  Services: type, ports, selector, cluster IP, LB hostnames; ingresses: class + rules; network policies: pod
  selector, policy types, ingress/egress peers and ports; annotations only for ingress class and AWS LB scheme /
  type. 35 s per cluster, no new cluster read starts after 45 s of the unit. A cluster the identity cannot read (401,
  403, unreachable) stays on the map as "not readable" with what to grant; when no member cluster is readable the
  unit ends `denied` with that text as its missing permission (e.g. `apps: EKS access entry for role X
  (AmazonEKSViewPolicy)`). Ingresses, network policies and nodes are optional (403 → warning).
- `aws.ecs` — `ecs:ListClusters/DescribeClusters`, `ListServices/DescribeServices` (batches of 10),
  `ListTasks/DescribeTasks` (at most 2000 tasks per cluster); keeps awsvpc services / tasks whose subnet or ENI is in
  a member network. Task definitions (env, secrets) are never read.
- `aws.lambda` — `lambda:ListFunctions`; keeps VPC-attached functions in member networks (environment dropped
  on receipt, nothing else stored but runtime, subnets, groups and state).

Edges: pod / task / function `runs-on` its ENI (a pod: the node ENI holding its IP, else the EC2 node), service and
network policy `selects` pods, ingress `backs` its services, service / ingress `backs` the load balancer named in
`status.loadBalancer.ingress`, load balancer `exposes` pods and tasks (ip-mode targets) and ECS services (target
group), ECS service `runs` tasks. Findings: `k8s-service-public-lb`, `k8s-namespace-no-networkpolicy`,
`ecs-task-public-ip`, `lambda-no-egress`. The path tracer starts from or ends at pods, tasks, functions, services and
ingresses, with a NetworkPolicy check for pods (only meaningful if the cluster runs a NetworkPolicy engine).

Cluster side, for `aws.eks` to see anything the scope's IAM role needs read access in each cluster (same as the
probe below): an EKS access entry with `AmazonEKSViewPolicy` (cluster scope) or an `aws-auth` mapping to a group
bound to the `view` ClusterRole, and a network path from the helpdesk backend to the API endpoint. The `view` role
does not cover nodes; without them pods whose IP is not on a collected ENI are not linked to their EC2 node.

### Kubernetes access (v2b spike)

`picker/k8s` checks whether the backend can read Kubernetes in a scope's EKS clusters with the scope's existing AWS
credentials (no new credential type). It builds the standard EKS bearer token (a SigV4-presigned
`sts:GetCallerIdentity` URL bound to the cluster name, as `aws eks get-token` does), trusts only the cluster's own CA,
and calls `GET /version` plus three `SelfSubjectAccessReview`s (`list` pods, services, networking.k8s.io
networkpolicies, cluster-wide), 6 s per call. Nothing is created or changed in the cluster.

Extra read-only IAM actions: `eks:ListClusters`, `eks:DescribeCluster`, `sts:GetCallerIdentity`.

Cluster side, the scope's IAM role (the role in `callerArn`) must be mapped, read-only:

- authenticationMode `API` / `API_AND_CONFIG_MAP`: an EKS access entry for the role with a read-only access policy
  such as `AmazonEKSViewPolicy` (cluster scope), or
- `CONFIG_MAP` / `API_AND_CONFIG_MAP`: an `aws-auth` mapping of the role to a group bound to the `view` ClusterRole.

The API endpoint must also be reachable from the helpdesk backend (public endpoint with `publicAccessCidrs` allowing
its egress IP, or a private network path). `message` explains the outcome: a timeout or connection failure means
no network path (often a private-only endpoint); 401 means the identity is not mapped; 403 or `allowed: false` means
it is mapped but lacks RBAC read; a TLS error means the server certificate did not validate against the cluster CA.

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
