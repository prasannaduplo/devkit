// TypeScript mirror of the netmap backend JSON (camelCase). Optional fields may be absent: the backend omits
// nulls. Framework-free: no @angular imports in model/.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface BlueprintMember {
  scopeId: string;
  provider: string;
  region: string;
  networkId: string;
  displayName?: string | null;
  cidrs?: string[];
}

export interface NetworkBlueprintSpec {
  purpose?: string | null;
  labels?: Record<string, string>;
  members: BlueprintMember[];
  scanRequestedAt?: string | null;
  scopeIds?: string[];
}

export interface ActiveScanInfo {
  snapshotId: string;
  sequence: number;
  requestedAt?: string | null;
  startedAt: string;
  membersHash: string;
  unitsTotal: number;
  unitsFinished: number;
  currentUnit?: string | null;
  rescanQueued: boolean;
}

export type CapabilityStateName = 'available' | 'partial' | 'not-readable' | 'none';

export interface CapabilityState {
  state: CapabilityStateName;
  reason: string;
  counts: Record<string, number>;
}

export interface SnapshotSummary {
  status: string;
  finishedAt: string;
  nodeCount: number;
  stubCount: number;
  edgeCount: number;
  kindCounts: Record<string, number>;
  capabilities: Record<string, CapabilityState>;
  findingsBad: number;
  findingsWarn: number;
  unitsTotal: number;
  unitsDone: number;
  unitsFailed: number;
  unitsDenied: number;
  unitProblems: string[];
}

export interface MemberStatus {
  scopeId: string;
  region: string;
  networkId: string;
  status: 'ok' | 'missing' | 'scope-error';
  displayName?: string | null;
  cidrs: string[];
  message?: string | null;
}

export interface NetworkBlueprintResult {
  activeScan?: ActiveScanInfo | null;
  lastSequence?: number;
  latestSnapshotId?: string | null;
  latestSummary?: SnapshotSummary | null;
  memberStatuses?: MemberStatus[];
  lastError?: string | null;
}

export interface NetworkBlueprint {
  id: string;
  name: string;
  status: string;
  subStatus?: string | null;
  createdAt?: string;
  updatedAt?: string;
  spec: NetworkBlueprintSpec;
  result?: NetworkBlueprintResult | null;
}

export interface WorkUnitView {
  id: string;
  collector: string;
  scopeId: string;
  region: string;
  status: string;
  attempts: number;
  error?: string | null;
  missingPermission?: string | null;
  collectedAt?: string | null;
}

export interface SnapshotHeader {
  id: string;
  sequence: number;
  trigger: string;
  scanStatus: string;
  startedAt: string;
  finishedAt?: string | null;
  sameAsSnapshotId?: string | null;
  summary?: SnapshotSummary | null;
  units: WorkUnitView[];
}

export interface PickerVpc {
  vpcId: string;
  name: string;
  cidrs: string[];
  subnetCount: number;
  tags: Record<string, string>;
  isDefault: boolean;
}

export interface WorkspaceScope {
  id: string;
  name: string;
  providerId?: string;
}

export type Visibility = 'full' | 'partial' | 'stub';

export interface GraphNode {
  id: string;
  kind: string;
  provider: string;
  account?: string;
  region?: string;
  nativeId: string;
  name: string;
  tags?: Record<string, string>;
  cidrs?: string[];
  ownerAccount?: string;
  seenFrom?: string[];
  visibility: Visibility;
  membership: 'blueprint' | 'outside-blueprint';
  parentId?: string;
  state?: string;
  nativeState?: string;
  attrs?: Record<string, Json>;
  raw?: Record<string, Json> | null;
  collectedBy?: string;
  collectedAt?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  attrs?: Record<string, Json>;
}

export interface Finding {
  ruleId: string;
  severity: 'ok' | 'warn' | 'bad';
  nodeIds: string[];
  edgeIds: string[];
  message: string;
}

export interface NetworkGraph {
  schemaVersion: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  findings: Finding[];
}

export interface KindInfo {
  kind: string;
  level: number;
  icon: string;
  label: string;
  container: boolean;
}
