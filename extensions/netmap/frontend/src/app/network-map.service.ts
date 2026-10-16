import { Injectable, Inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

const REST_SEGMENT = 'extensions/networkmaps';
// MUST equal manifest resources[].restSegment AND the controller [Route] — see reference/00-naming.md.

export interface NetworkMapSpec {
  region?: string;
  scopeIds?: string[];
}

export interface VpcSummary {
  vpcId: string;
  name: string;
  cidr: string;
  subnetCount: number;
  resourceCount: number;
  inboundOpenSecurityGroupCount: number;
  outboundOpenSecurityGroupCount: number;
}

/** One load balancer cross-referenced with every Route53 record that resolves to it. urls is empty when
 * the load balancer has no DNS record pointing at it -- still worth listing, since "reachable only by its
 * raw AWS DNS name" is itself a posture fact. */
export interface EndpointInfo {
  name: string;
  dnsName: string;
  scheme: string; // "internet-facing" | "internal"
  vpcId: string;
  urls: string[];
}

export interface VpnTunnelInfo {
  customerGatewayIp: string;
  status: string;
}

/** A Virtual Private Gateway -- the AWS side of a Site-to-Site VPN -- with every tunnel reaching it. This
 * is the on-prem/"network I don't know about" path a security group can't describe. */
export interface VpnGatewayInfo {
  id: string;
  state: string;
  attachedVpcIds: string[];
  tunnels: VpnTunnelInfo[];
}

export interface TransitGatewayAttachmentInfo {
  vpcId: string;
  attachmentId: string;
}

/** A Transit Gateway and the VPCs attached to it -- the hub-and-spoke path that lets one VPC reach another
 * without any security-group rule describing it. */
export interface TransitGatewayInfo {
  id: string;
  state: string;
  attachments: TransitGatewayAttachmentInfo[];
}

/** A direct VPC-to-VPC route that bypasses the Transit Gateway (and the SG-reference model) entirely. */
export interface VpcPeeringInfo {
  id: string;
  requesterVpcId: string;
  requesterCidr: string;
  accepterVpcId: string;
  accepterCidr: string;
  status: string;
}

export interface ConnectivitySummary {
  vpnGateways: VpnGatewayInfo[];
  transitGateways: TransitGatewayInfo[];
  vpcPeerings: VpcPeeringInfo[];
}

export interface NetworkMapResult {
  vpcs?: VpcSummary[];
  endpoints?: EndpointInfo[];
  connectivity?: ConnectivitySummary;
  lastScannedAt?: string;
  scanError?: string;
}

export interface NetworkMap {
  id: string;
  name: string;
  status: string;
  subStatus?: string;
  createdAt?: string;
  spec?: NetworkMapSpec;
  result?: NetworkMapResult;
}

export interface ResourceNode {
  id: string;
  name: string;
  kind: string;
  inboundOpen: boolean;
  outboundOpen: boolean;
  openDetails: string[];
  /** Route53 hostnames that resolve to this resource (matched via its load balancer, if it is one).
   * Empty for anything that isn't a load balancer or has no DNS record pointing at it. */
  urls: string[];
}

/** All resources in one subnet sharing one security group. id is "{subnetId}::{sgId}" -- the composite
 * key connections are drawn between. */
export interface SecurityGroupCard {
  id: string;
  securityGroupId: string;
  name: string;
  inboundOpen: boolean;
  outboundOpen: boolean;
  resources: ResourceNode[];
}

export interface SubnetLane {
  subnetId: string;
  cidr: string;
  availabilityZone: string;
  isPublic: boolean;
  securityGroups: SecurityGroupCard[];
  /** Route-table targets that aren't the internet or the implicit local route: vgw-/tgw-/pcx- ids. */
  externalRouteTargets: string[];
}

/** One bucketed rule behind an edge -- label is a protocol/port for card-to-card edges (e.g. "tcp/443")
 * or a full open-rule description for internet edges (e.g. "outbound all ports to 0.0.0.0/0"). */
export interface ConnectionRule {
  label: string;
  count: number;
}

export interface ConnectionEdge {
  fromId: string;
  toId: string;
  count: number;
  toInternet: boolean;
  fromInternet: boolean;
  rules: ConnectionRule[];
}

export interface VpcDetail {
  vpcId: string;
  cidr: string;
  subnets: SubnetLane[];
  connections: ConnectionEdge[];
}

@Injectable({ providedIn: 'root' })
export class NetworkMapService {
  constructor(
    @Inject(REMOTE_DuploHttpClient) private http: any,
    @Inject(REMOTE_UserSession) private session: any,
  ) {}

  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private base(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment/${REST_SEGMENT}`;
  }

  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);

  list(): Observable<NetworkMap[]> {
    return this.http.get(this.base()).pipe(map((r: any) => {
      const d = this.unwrap(r);
      return (d?.items ?? d ?? []) as NetworkMap[];
    }));
  }

  get(id: string): Observable<NetworkMap> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: NetworkMapSpec): Observable<NetworkMap> {
    return this.http.post(this.base(), { name, spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  update(id: string, spec: NetworkMapSpec): Observable<NetworkMap> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  delete(id: string): Observable<void> {
    return this.http.delete(`${this.base()}/${id}`);
  }

  /** Live per-VPC drill-down: resources grouped by subnet + connections, computed fresh on every call
   * (not persisted — see NetworkMapController.VpcDetail). */
  vpcDetail(id: string, vpcId: string): Observable<VpcDetail> {
    return this.http.get(`${this.base()}/${id}/vpcs/${vpcId}/detail`).pipe(map((r: any) => this.unwrap(r)));
  }
}
