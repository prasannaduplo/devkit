using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using Amazon.EC2;
using Amazon.EC2.Model;
using Amazon.ElasticLoadBalancingV2;
using Amazon.ElasticLoadBalancingV2.Model;
using Amazon.Route53;
using Amazon.Route53.Model;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.NetMap;

// NO-PROVISION, ENRICHMENT-ONLY extension — reads live AWS network state and presents it visually; it
// never creates/modifies anything in AWS. Create the resource once (pick a scope + region); every GET
// re-scans the account live via EnrichResultAsync (account-level VPC summary, cheap) and a drill-down
// into one VPC is served by a custom controller action (NetworkMapController.VpcDetail) computed live,
// never persisted -- see reference/12-enrichment-and-live-state.md.
//
// "Exposed" means a security group rule with a CIDR of 0.0.0.0/0 or ::/0, on EITHER side: inbound
// (classic "open to the internet") AND outbound (a customer requirement -- "I can't have traffic
// initiated from inside a network I don't know about"). Both get flagged, not just inbound.

[BsonIgnoreExtraElements]
public class NetworkMapSpec : BaseSpec
{
    /// <summary>AWS region to scan. VPCs are regional; one scan covers one region.</summary>
    public string? Region { get; set; }
}

/// <summary>Account-level row: one VPC's identity + a cheap risk count, restricted to security groups
/// actually attached to a live ENI (an orphaned security group with a dangerous rule but nothing using it
/// is a different finding and would otherwise inflate this count while the drill-down shows nothing for
/// it). Inbound and outbound are counted separately -- inbound exposure is the classic attack surface;
/// outbound-open is AWS's own default-allow-egress on a fresh group, so it's a lesser signal by default
/// (see the per-resource severity split in the drill-down).</summary>
public class VpcSummary
{
    public string? VpcId { get; set; }
    public string? Name { get; set; }
    public string? Cidr { get; set; }
    public int SubnetCount { get; set; }
    public int ResourceCount { get; set; }
    public int InboundOpenSecurityGroupCount { get; set; }
    public int OutboundOpenSecurityGroupCount { get; set; }
}

/// <summary>One load balancer, cross-referenced against every Route53 record that resolves to it (ALIAS or
/// CNAME). Urls is empty when the load balancer has no DNS record pointing at it -- still worth listing,
/// since "reachable only by its raw AWS DNS name" is itself a posture fact.</summary>
public class EndpointInfo
{
    public string? Name { get; set; }
    public string? DnsName { get; set; }
    /// <summary>"internet-facing" or "internal", straight from the load balancer's own Scheme.</summary>
    public string? Scheme { get; set; }
    public string? VpcId { get; set; }
    public List<string> Urls { get; set; } = new();
}

/// <summary>One Site-to-Site VPN tunnel (a VPN Connection has two, for redundancy).</summary>
public class VpnTunnelInfo
{
    public string? CustomerGatewayIp { get; set; }
    public string? Status { get; set; }
}

/// <summary>A Virtual Private Gateway -- the AWS side of a Site-to-Site VPN -- with the VPCs it's attached
/// to and every tunnel reaching it. This is the on-prem/"network I don't know about" path the original requirement was
/// originally about, separate from anything a security group can describe.</summary>
public class VpnGatewayInfo
{
    public string? Id { get; set; }
    public string? State { get; set; }
    public List<string> AttachedVpcIds { get; set; } = new();
    public List<VpnTunnelInfo> Tunnels { get; set; } = new();
}

public class TransitGatewayAttachmentInfo
{
    public string? VpcId { get; set; }
    public string? AttachmentId { get; set; }
}

/// <summary>A Transit Gateway and the VPCs attached to it -- the hub-and-spoke path that lets one VPC reach
/// another without a security-group rule anywhere describing it.</summary>
public class TransitGatewayInfo
{
    public string? Id { get; set; }
    public string? State { get; set; }
    public List<TransitGatewayAttachmentInfo> Attachments { get; set; } = new();
}

/// <summary>A direct VPC-to-VPC route that bypasses the Transit Gateway (and the SG-reference model)
/// entirely.</summary>
public class VpcPeeringInfo
{
    public string? Id { get; set; }
    public string? RequesterVpcId { get; set; }
    public string? RequesterCidr { get; set; }
    public string? AccepterVpcId { get; set; }
    public string? AccepterCidr { get; set; }
    public string? Status { get; set; }
}

public class ConnectivitySummary
{
    public List<VpnGatewayInfo> VpnGateways { get; set; } = new();
    public List<TransitGatewayInfo> TransitGateways { get; set; } = new();
    public List<VpcPeeringInfo> VpcPeerings { get; set; } = new();
}

[BsonIgnoreExtraElements]
public class NetworkMapResult : BaseResult
{
    public List<VpcSummary> Vpcs { get; set; } = new();
    public List<EndpointInfo> Endpoints { get; set; } = new();
    public ConnectivitySummary Connectivity { get; set; } = new();
    public DateTime? LastScannedAt { get; set; }
    /// <summary>Set when the live scan itself fails (e.g. no scope attached) -- surfaced instead of
    /// silently returning an empty account view.</summary>
    public string? ScanError { get; set; }
}

[BsonCollection("extension_networkmaps")]
public class NetworkMap : ResourceBase<NetworkMapSpec, NetworkMapResult>
{
    public override string GetTicketOriginType() => "NetworkMap";
    public override string GetTicketOriginSubType() => "network-map";
}

public class NetworkMapHooks : DefaultEntityHooks<NetworkMap>
{
}

public class NetworkMapService : ResourceServiceBase<NetworkMap, NetworkMapSpec, NetworkMapResult>
{
    private readonly IScopeClientFactory _clients;

    public NetworkMapService(
        IRepository<NetworkMap> repository,
        ILogger<NetworkMapService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor,
        IScopeClientFactory clients)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
        _clients = clients;
    }

    // No ticket, no skill, no worker -- creating this resource just records which scope/region to view.
    // Create completes immediately with Status = Complete.
    protected override bool IsProvisioningNeeded(NetworkMap entity) => false;

    protected override Task ValidateSpecAsync(NetworkMapSpec spec, bool isUpdate, NetworkMapSpec? existingSpec, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(spec.Region))
            throw new ArgumentException("Region is required.");
        if (spec.ScopeIds == null || spec.ScopeIds.Count == 0)
            throw new ArgumentException("Attach an AWS scope to scan its network.");
        return Task.CompletedTask;
    }

    // Runs inside GetByIdAsync on every GET -- the account-level VPC list is always freshly scanned,
    // never persisted. Kept intentionally cheap (no per-resource ENI walk here; that's the drill-down's
    // job) so the account view loads fast even for an account with many VPCs.
    protected override async Task EnrichResultAsync(NetworkMap entity, CancellationToken ct)
    {
        entity.Result ??= new NetworkMapResult();
        var spec = entity.Spec;
        if (spec?.Region == null) return;

        try
        {
            using var ec2 = await _clients.CreateAwsClientAsync(
                spec.ScopeIds, spec.Region, (c, r) => new AmazonEC2Client(c, r), ct: ct);

            var vpcs = await ec2.DescribeVpcsAsync(new DescribeVpcsRequest(), ct);
            var summaries = new List<VpcSummary>();

            foreach (var vpc in vpcs.Vpcs)
            {
                var subnets = await ec2.DescribeSubnetsAsync(new DescribeSubnetsRequest
                {
                    Filters = new List<Filter> { new Filter("vpc-id", new List<string> { vpc.VpcId }) },
                }, ct);

                var sgs = await ec2.DescribeSecurityGroupsAsync(new DescribeSecurityGroupsRequest
                {
                    Filters = new List<Filter> { new Filter("vpc-id", new List<string> { vpc.VpcId }) },
                }, ct);

                // Same unit the drill-down counts (one ENI = one resource node) so this number matches
                // what you see after clicking in.
                var enis = await ec2.DescribeNetworkInterfacesAsync(new DescribeNetworkInterfacesRequest
                {
                    Filters = new List<Filter> { new Filter("vpc-id", new List<string> { vpc.VpcId }) },
                }, ct);

                // Only security groups actually attached to a live ENI count toward the badge -- an unused
                // group with a dangerous rule but nothing wired to it is a hygiene finding, not "this VPC
                // has an exposed resource", and would otherwise contradict the drill-down (which only ever
                // draws cards for groups with members).
                var attachedSgIds = new HashSet<string>(enis.NetworkInterfaces.SelectMany(e => e.Groups.Select(g => g.GroupId)));
                var attachedSgs = sgs.SecurityGroups.Where(sg => attachedSgIds.Contains(sg.GroupId)).ToList();
                var inboundOpenCount = attachedSgs.Count(sg => sg.IpPermissions.Any(IsOpenPermission));
                var outboundOpenCount = attachedSgs.Count(sg => sg.IpPermissionsEgress.Any(IsOpenPermission));
                var nameTag = vpc.Tags?.FirstOrDefault(t => t.Key == "Name")?.Value;

                summaries.Add(new VpcSummary
                {
                    VpcId = vpc.VpcId,
                    Name = string.IsNullOrEmpty(nameTag) ? vpc.VpcId : nameTag,
                    Cidr = vpc.CidrBlock,
                    SubnetCount = subnets.Subnets.Count,
                    ResourceCount = enis.NetworkInterfaces.Count,
                    InboundOpenSecurityGroupCount = inboundOpenCount,
                    OutboundOpenSecurityGroupCount = outboundOpenCount,
                });
            }

            entity.Result.Vpcs = summaries;
            entity.Result.Endpoints = await ScanEndpointsAsync(spec, ct);
            entity.Result.Connectivity = await ScanConnectivityAsync(spec, ct);
            entity.Result.LastScannedAt = DateTime.UtcNow;
            entity.Result.ScanError = null;
        }
        catch (Exception ex)
        {
            // A GET must never 500 because AWS/the scope hiccuped -- surface it in the result instead.
            entity.Result.ScanError = ex.Message;
        }
    }

    /// <summary>Every ELBv2 load balancer in the region, cross-referenced against Route53 so a public/
    /// internal URL shows up instead of just a raw AWS DNS name. Deliberately its own try/catch, separate
    /// from the block above: a scope without ELB/Route53 permission (or a region with neither) should not
    /// blank out the VPC list that already scanned fine -- this is a best-effort extra, not core.</summary>
    private async Task<List<EndpointInfo>> ScanEndpointsAsync(NetworkMapSpec spec, CancellationToken ct)
    {
        try
        {
            using var elb = await _clients.CreateAwsClientAsync(
                spec.ScopeIds, spec.Region!, (c, r) => new AmazonElasticLoadBalancingV2Client(c, r), ct: ct);
            var lbResp = await elb.DescribeLoadBalancersAsync(new DescribeLoadBalancersRequest(), ct);
            if (lbResp.LoadBalancers.Count == 0) return new List<EndpointInfo>();

            using var r53 = await _clients.CreateAwsClientAsync(
                spec.ScopeIds, spec.Region!, (c, r) => new AmazonRoute53Client(c, r), ct: ct);
            var zones = await r53.ListHostedZonesAsync(new ListHostedZonesRequest(), ct);

            // "The load balancer's own DNS name" -> every hostname in Route53 that resolves to it (ALIAS or
            // CNAME) -- an ELB otherwise known only by its raw AWS DNS name shows the human URL instead.
            var urlsByLbDns = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var zone in zones.HostedZones)
            {
                string? nextName = null;
                do
                {
                    var recResp = await r53.ListResourceRecordSetsAsync(new ListResourceRecordSetsRequest
                    {
                        HostedZoneId = zone.Id,
                        StartRecordName = nextName,
                    }, ct);

                    foreach (var rr in recResp.ResourceRecordSets)
                    {
                        var target = rr.AliasTarget?.DNSName?.TrimEnd('.');
                        if (target == null && rr.Type == RRType.CNAME)
                            target = rr.ResourceRecords.FirstOrDefault()?.Value?.TrimEnd('.');
                        if (string.IsNullOrEmpty(target)) continue;

                        var hostname = rr.Name.TrimEnd('.');
                        (urlsByLbDns.TryGetValue(target, out var list) ? list : urlsByLbDns[target] = new()).Add(hostname);
                    }

                    nextName = recResp.IsTruncated == true ? recResp.NextRecordName : null;
                } while (nextName != null);
            }

            return lbResp.LoadBalancers.Select(lb => new EndpointInfo
            {
                Name = lb.LoadBalancerName,
                DnsName = lb.DNSName,
                Scheme = lb.Scheme?.Value,
                VpcId = lb.VpcId,
                Urls = urlsByLbDns.GetValueOrDefault(lb.DNSName?.TrimEnd('.') ?? string.Empty, new List<string>()),
            }).ToList();
        }
        catch
        {
            return new List<EndpointInfo>();
        }
    }

    /// <summary>VPN Gateways + their tunnels, Transit Gateways + their VPC attachments, and active VPC
    /// Peering connections -- the three connectivity paths that bring traffic into a VPC without any
    /// security-group rule describing them (see the header comment). Best-effort and separate
    /// from the account-level try/catch, same reasoning as ScanEndpointsAsync: a scope without EC2 VPN/TGW
    /// permission shouldn't blank out the VPC list that already scanned fine.</summary>
    private async Task<ConnectivitySummary> ScanConnectivityAsync(NetworkMapSpec spec, CancellationToken ct)
    {
        try
        {
            using var ec2 = await _clients.CreateAwsClientAsync(
                spec.ScopeIds, spec.Region!, (c, r) => new AmazonEC2Client(c, r), ct: ct);

            var cgwResp = await ec2.DescribeCustomerGatewaysAsync(new DescribeCustomerGatewaysRequest(), ct);
            var cgwById = cgwResp.CustomerGateways.ToDictionary(c => c.CustomerGatewayId);

            var vpnConnResp = await ec2.DescribeVpnConnectionsAsync(new DescribeVpnConnectionsRequest(), ct);
            var vgwResp = await ec2.DescribeVpnGatewaysAsync(new DescribeVpnGatewaysRequest(), ct);

            var vpnGateways = vgwResp.VpnGateways.Select(vgw => new VpnGatewayInfo
            {
                Id = vgw.VpnGatewayId,
                State = vgw.State?.Value,
                AttachedVpcIds = vgw.VpcAttachments
                    .Where(a => a.State?.Value == "attached")
                    .Select(a => a.VpcId).ToList(),
                Tunnels = vpnConnResp.VpnConnections
                    .Where(c => c.VpnGatewayId == vgw.VpnGatewayId)
                    .SelectMany(c => c.VgwTelemetry.Select(t => new VpnTunnelInfo
                    {
                        CustomerGatewayIp = cgwById.GetValueOrDefault(c.CustomerGatewayId)?.IpAddress,
                        Status = t.Status?.Value,
                    }))
                    .ToList(),
            }).ToList();

            var tgwResp = await ec2.DescribeTransitGatewaysAsync(new DescribeTransitGatewaysRequest(), ct);
            var tgwAttachResp = await ec2.DescribeTransitGatewayAttachmentsAsync(new DescribeTransitGatewayAttachmentsRequest(), ct);

            var transitGateways = tgwResp.TransitGateways.Select(tgw => new TransitGatewayInfo
            {
                Id = tgw.TransitGatewayId,
                State = tgw.State?.Value,
                Attachments = tgwAttachResp.TransitGatewayAttachments
                    .Where(a => a.TransitGatewayId == tgw.TransitGatewayId && a.ResourceType?.Value == "vpc")
                    .Select(a => new TransitGatewayAttachmentInfo { VpcId = a.ResourceId, AttachmentId = a.TransitGatewayAttachmentId })
                    .ToList(),
            }).ToList();

            var pcxResp = await ec2.DescribeVpcPeeringConnectionsAsync(new DescribeVpcPeeringConnectionsRequest(), ct);
            var peerings = pcxResp.VpcPeeringConnections
                .Where(p => p.Status?.Code?.Value == "active")
                .Select(p => new VpcPeeringInfo
                {
                    Id = p.VpcPeeringConnectionId,
                    RequesterVpcId = p.RequesterVpcInfo?.VpcId,
                    RequesterCidr = p.RequesterVpcInfo?.CidrBlock,
                    AccepterVpcId = p.AccepterVpcInfo?.VpcId,
                    AccepterCidr = p.AccepterVpcInfo?.CidrBlock,
                    Status = p.Status?.Code?.Value,
                }).ToList();

            return new ConnectivitySummary { VpnGateways = vpnGateways, TransitGateways = transitGateways, VpcPeerings = peerings };
        }
        catch
        {
            return new ConnectivitySummary();
        }
    }

    /// <summary>True if a rule allows 0.0.0.0/0 or ::/0 -- the one "open" definition shared by the
    /// account-level scan above and the per-VPC drill-down below.</summary>
    internal static bool IsOpenPermission(IpPermission perm) =>
        perm.Ipv4Ranges.Any(r => r.CidrIp == "0.0.0.0/0") ||
        perm.Ipv6Ranges.Any(r => r.CidrIpv6 == "::/0");

    /// <summary>The per-VPC drill-down: AZ-aware subnets, resources grouped under the security group(s)
    /// they're attached to (not shown flat per subnet -- see "SecurityGroupCard" below), connections
    /// aggregated to SECURITY-GROUP-CARD pairs with a protocol/port rule breakdown rather than one edge per
    /// resource pair. A busy VPC (dozens of ENIs sharing a few groups) renders as a handful of cards and
    /// edges instead of hundreds of lines. Called from NetworkMapController.GetVpcDetail -- lives here, not
    /// on the controller, because IScopeClientFactory only resolves at the service layer in this host (see
    /// the controller's comment). Returns null if the VPC doesn't exist in this region/account.</summary>
    public async Task<VpcDetail?> GetVpcDetailAsync(NetworkMap entity, string vpcId, CancellationToken ct)
    {
        var spec = entity.Spec!;
        using var ec2 = await _clients.CreateAwsClientAsync(
            spec.ScopeIds, spec.Region!, (c, r) => new AmazonEC2Client(c, r), ct: ct);

        var vpcResp = await ec2.DescribeVpcsAsync(new DescribeVpcsRequest { VpcIds = new List<string> { vpcId } }, ct);
        var vpc = vpcResp.Vpcs.FirstOrDefault();
        if (vpc is null) return null;

        var subnetsResp = await ec2.DescribeSubnetsAsync(new DescribeSubnetsRequest
        { Filters = new List<Filter> { new Filter("vpc-id", new List<string> { vpcId }) } }, ct);

        var routeTablesResp = await ec2.DescribeRouteTablesAsync(new DescribeRouteTablesRequest
        { Filters = new List<Filter> { new Filter("vpc-id", new List<string> { vpcId }) } }, ct);

        var sgsResp = await ec2.DescribeSecurityGroupsAsync(new DescribeSecurityGroupsRequest
        { Filters = new List<Filter> { new Filter("vpc-id", new List<string> { vpcId }) } }, ct);
        var sgsById = sgsResp.SecurityGroups.ToDictionary(s => s.GroupId);

        var enisResp = await ec2.DescribeNetworkInterfacesAsync(new DescribeNetworkInterfacesRequest
        { Filters = new List<Filter> { new Filter("vpc-id", new List<string> { vpcId }) } }, ct);

        var instanceIds = enisResp.NetworkInterfaces
            .Select(e => e.Attachment?.InstanceId).Where(i => !string.IsNullOrEmpty(i)).Distinct().ToList();
        var instanceNames = new Dictionary<string, string>();
        if (instanceIds.Count > 0)
        {
            var instResp = await ec2.DescribeInstancesAsync(new DescribeInstancesRequest { InstanceIds = instanceIds! }, ct);
            foreach (var r in instResp.Reservations)
            foreach (var i in r.Instances)
            {
                var nameTag = i.Tags?.FirstOrDefault(t => t.Key == "Name")?.Value;
                instanceNames[i.InstanceId] = string.IsNullOrEmpty(nameTag) ? i.InstanceId : nameTag;
            }
        }

        var isPublic = ClassifySubnets(subnetsResp.Subnets, routeTablesResp.RouteTables);
        var externalRoutes = ExternalRoutesBySubnet(subnetsResp.Subnets, routeTablesResp.RouteTables);

        // Load balancers in this VPC, cross-referenced with Route53 -- matched to their own ENI below by
        // AWS's own ENI description convention ("ELB app/<lb-name>/<id>" / "ELB net/<lb-name>/<id>"
        // contains the load balancer's name verbatim) so the resource row shows its real URL, not just
        // "Load Balancer".
        var vpcEndpoints = (await ScanEndpointsAsync(spec, ct)).Where(e => e.VpcId == vpcId).ToList();

        // One ResourceNode per ENI, kept alongside which subnet it lives in and which security group(s)
        // it carries -- used below to bucket resources into cards instead of listing them flat.
        var nodes = new List<ResourceNode>();
        var nodeSubnet = new Dictionary<string, string>();
        var nodeSgIds = new Dictionary<string, List<string>>();
        foreach (var eni in enisResp.NetworkInterfaces)
        {
            var (name, kind) = DescribeEni(eni, instanceNames);
            var attachedSgs = eni.Groups.Select(g => g.GroupId).Select(gid => sgsById.GetValueOrDefault(gid)).Where(s => s != null).ToList();
            var inboundOpen = attachedSgs.Any(s => s!.IpPermissions.Any(IsOpenPermission));
            var outboundOpen = attachedSgs.Any(s => s!.IpPermissionsEgress.Any(IsOpenPermission));
            var details = new List<string>();
            foreach (var sg in attachedSgs)
            {
                details.AddRange(sg!.IpPermissions.Where(IsOpenPermission).Select(p => $"inbound {PortLabel(p)} from 0.0.0.0/0"));
                details.AddRange(sg!.IpPermissionsEgress.Where(IsOpenPermission).Select(p => $"outbound {PortLabel(p)} to 0.0.0.0/0"));
            }

            var matchedLb = !string.IsNullOrEmpty(eni.Description)
                ? vpcEndpoints.FirstOrDefault(e => !string.IsNullOrEmpty(e.Name) && eni.Description.Contains(e.Name!))
                : null;
            var urls = matchedLb is null ? new List<string>()
                : matchedLb.Urls.Count > 0 ? matchedLb.Urls : new List<string> { matchedLb.DnsName! };

            var node = new ResourceNode(eni.NetworkInterfaceId, name, kind, inboundOpen, outboundOpen, details.Distinct().ToList(), urls);
            nodes.Add(node);
            nodeSubnet[node.Id] = eni.SubnetId;
            nodeSgIds[node.Id] = eni.Groups.Select(g => g.GroupId).Where(sgsById.ContainsKey).ToList();
        }

        // Composite card id "{subnetId}::{sgId}" -- members of one security group physically in one
        // subnet. A security group's rules are VPC-wide but a card is what the canvas actually draws, so
        // a group with members in two subnets/AZs becomes two cards (and, if it self-references, an edge
        // between them -- which is real cross-AZ connectivity, e.g. EKS node-to-node traffic).
        var cardMembers = new Dictionary<string, List<ResourceNode>>();
        foreach (var node in nodes)
            foreach (var sgId in nodeSgIds[node.Id])
            {
                var cardId = $"{nodeSubnet[node.Id]}::{sgId}";
                (cardMembers.TryGetValue(cardId, out var list) ? list : cardMembers[cardId] = new()).Add(node);
            }

        var subnetLanes = subnetsResp.Subnets.Select(s =>
        {
            var cardsInSubnet = cardMembers.Keys
                .Where(cid => SplitCardId(cid).SubnetId == s.SubnetId)
                .Select(cid =>
                {
                    var sgId = SplitCardId(cid).SgId;
                    var members = cardMembers[cid];
                    var sg = sgsById.GetValueOrDefault(sgId);
                    return new SecurityGroupCard(
                        cid, sgId, sg?.GroupName ?? sgId,
                        members.Any(m => m.InboundOpen), members.Any(m => m.OutboundOpen), members);
                })
                .OrderBy(c => c.Name)
                .ToList();
            return new SubnetLane(
                s.SubnetId, s.CidrBlock, s.AvailabilityZone, isPublic.GetValueOrDefault(s.SubnetId, false), cardsInSubnet,
                externalRoutes.GetValueOrDefault(s.SubnetId, new List<string>()));
        }).ToList();

        // SG-reference edges aggregate to CARD pairs: an ingress rule on destCard's security group that
        // references sourceCard's security group as the source means "sourceCard can reach destCard" --
        // bucketed by (fromCard, toCard, rule) with a resource-pair count instead of one edge per pair.
        var cardIdsBySgId = new Dictionary<string, List<string>>();
        foreach (var cardId in cardMembers.Keys)
        {
            var sgId = SplitCardId(cardId).SgId;
            (cardIdsBySgId.TryGetValue(sgId, out var list) ? list : cardIdsBySgId[sgId] = new()).Add(cardId);
        }

        var edgeBuckets = new Dictionary<(string From, string To), Dictionary<string, int>>();
        foreach (var destCardId in cardMembers.Keys)
        {
            var destSgId = SplitCardId(destCardId).SgId;
            var destSg = sgsById.GetValueOrDefault(destSgId);
            if (destSg is null) continue;
            var destCount = cardMembers[destCardId].Count;

            foreach (var perm in destSg.IpPermissions)
            foreach (var pair in perm.UserIdGroupPairs)
            {
                if (!cardIdsBySgId.TryGetValue(pair.GroupId, out var sourceCardIds)) continue;
                var ruleLabel = PortLabel(perm);
                foreach (var sourceCardId in sourceCardIds.Where(sid => sid != destCardId))
                {
                    var bucket = edgeBuckets.TryGetValue((sourceCardId, destCardId), out var b) ? b : edgeBuckets[(sourceCardId, destCardId)] = new();
                    bucket[ruleLabel] = bucket.GetValueOrDefault(ruleLabel) + cardMembers[sourceCardId].Count * destCount;
                }
            }
        }

        var connections = edgeBuckets.Select(kv => new ConnectionEdge(
            kv.Key.From, kv.Key.To, kv.Value.Values.Sum(), false, false,
            kv.Value.Select(r => new ConnectionRule(r.Key, r.Value)).ToList())).ToList();

        // Internet exposure -- one aggregated edge per card (not per resource), with a breakdown of the
        // distinct open rules behind it so the UI can show "why" on click.
        foreach (var (cardId, members) in cardMembers)
        {
            var inboundMembers = members.Where(m => m.InboundOpen).ToList();
            if (inboundMembers.Count > 0)
            {
                var rules = inboundMembers.SelectMany(m => m.OpenDetails.Where(d => d.StartsWith("inbound")))
                    .GroupBy(d => d).Select(g => new ConnectionRule(g.Key, g.Count())).ToList();
                connections.Add(new ConnectionEdge("internet", cardId, inboundMembers.Count, false, true, rules));
            }
            var outboundMembers = members.Where(m => m.OutboundOpen).ToList();
            if (outboundMembers.Count > 0)
            {
                var rules = outboundMembers.SelectMany(m => m.OpenDetails.Where(d => d.StartsWith("outbound")))
                    .GroupBy(d => d).Select(g => new ConnectionRule(g.Key, g.Count())).ToList();
                connections.Add(new ConnectionEdge(cardId, "internet", outboundMembers.Count, true, false, rules));
            }
        }

        return new VpcDetail(vpcId, vpc.CidrBlock, subnetLanes, connections);
    }

    private static (string SubnetId, string SgId) SplitCardId(string cardId)
    {
        var i = cardId.IndexOf("::", StringComparison.Ordinal);
        return (cardId[..i], cardId[(i + 2)..]);
    }

    /// <summary>A subnet is public if its (explicitly associated, or else the VPC's main) route table has
    /// a route to an Internet Gateway (igw-...).</summary>
    private static Dictionary<string, bool> ClassifySubnets(List<Subnet> subnets, List<RouteTable> routeTables)
    {
        var mainRt = routeTables.FirstOrDefault(rt => rt.Associations.Any(a => a.Main == true));
        var result = new Dictionary<string, bool>();
        foreach (var subnet in subnets)
        {
            var explicitRt = routeTables.FirstOrDefault(rt => rt.Associations.Any(a => a.SubnetId == subnet.SubnetId));
            var rt = explicitRt ?? mainRt;
            result[subnet.SubnetId] = rt?.Routes.Any(r => r.GatewayId != null && r.GatewayId.StartsWith("igw-")) ?? false;
        }
        return result;
    }

    /// <summary>Per subnet, every route target that isn't the internet (igw-) or the implicit "local" VPC
    /// route -- a vgw- id means that subnet can reach on-prem over the Site-to-Site VPN, a tgw- id means it
    /// can reach whatever else the Transit Gateway attaches to, a pcx- id means it can reach a peered VPC
    /// directly. None of this is visible to the security-group model above; it comes from the route table
    /// alone, the same data ClassifySubnets already reads for the public/private check.</summary>
    private static Dictionary<string, List<string>> ExternalRoutesBySubnet(List<Subnet> subnets, List<RouteTable> routeTables)
    {
        var mainRt = routeTables.FirstOrDefault(rt => rt.Associations.Any(a => a.Main == true));
        var result = new Dictionary<string, List<string>>();
        foreach (var subnet in subnets)
        {
            var explicitRt = routeTables.FirstOrDefault(rt => rt.Associations.Any(a => a.SubnetId == subnet.SubnetId));
            var rt = explicitRt ?? mainRt;
            var targets = new List<string>();
            foreach (var r in rt?.Routes ?? new List<Route>())
            {
                if (!string.IsNullOrEmpty(r.GatewayId) && r.GatewayId.StartsWith("vgw-")) targets.Add(r.GatewayId);
                if (!string.IsNullOrEmpty(r.TransitGatewayId)) targets.Add(r.TransitGatewayId);
                if (!string.IsNullOrEmpty(r.VpcPeeringConnectionId)) targets.Add(r.VpcPeeringConnectionId);
            }
            result[subnet.SubnetId] = targets.Distinct().ToList();
        }
        return result;
    }

    private static (string Name, string Kind) DescribeEni(NetworkInterface eni, Dictionary<string, string> instanceNames)
    {
        if (!string.IsNullOrEmpty(eni.Attachment?.InstanceId) && instanceNames.TryGetValue(eni.Attachment.InstanceId, out var name))
            return (name, "EC2 Instance");
        var desc = eni.Description ?? "";
        if (desc.Contains("RDS", StringComparison.OrdinalIgnoreCase)) return (desc, "RDS");
        if (desc.Contains("ELB", StringComparison.OrdinalIgnoreCase)) return (desc, "Load Balancer");
        if (desc.Contains("Lambda", StringComparison.OrdinalIgnoreCase)) return (desc, "Lambda");
        if (desc.Contains("NAT Gateway", StringComparison.OrdinalIgnoreCase)) return (desc, "NAT Gateway");
        return (string.IsNullOrEmpty(desc) ? eni.NetworkInterfaceId : desc, "Other");
    }

    private static string PortLabel(IpPermission perm) =>
        perm.IpProtocol == "-1" ? "all ports" :
        perm.FromPort == perm.ToPort ? $"{perm.IpProtocol}/{perm.FromPort}" : $"{perm.IpProtocol}/{perm.FromPort}-{perm.ToPort}";
}
