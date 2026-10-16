using Amazon.EC2.Model;
using Amazon.NetworkFirewall.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Fetch;

public sealed class CoreNetworkCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.CoreNetwork;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ec2 = await aws.Ec2(ct);
        var warnings = new List<string>();
        var vpcs = ctx.MemberVpcIds.ToList();
        var byVpc = Fetch.F("vpc-id", vpcs);

        var vpcList = await Aws.All(ec2.Paginators.DescribeVpcs(new DescribeVpcsRequest { Filters = byVpc }).Vpcs, ct);
        var subnets = await Aws.All(ec2.Paginators.DescribeSubnets(new DescribeSubnetsRequest { Filters = byVpc }).Subnets, ct);
        var routeTables = await Aws.All(ec2.Paginators.DescribeRouteTables(new DescribeRouteTablesRequest { Filters = byVpc }).RouteTables, ct);
        var acls = await Aws.All(ec2.Paginators.DescribeNetworkAcls(new DescribeNetworkAclsRequest { Filters = byVpc }).NetworkAcls, ct);
        var igws = await Aws.All(ec2.Paginators.DescribeInternetGateways(new DescribeInternetGatewaysRequest { Filters = Fetch.F("attachment.vpc-id", vpcs) }).InternetGateways, ct);
        var eigws = (await Aws.All(ec2.Paginators.DescribeEgressOnlyInternetGateways(new DescribeEgressOnlyInternetGatewaysRequest()).EgressOnlyInternetGateways, ct))
            .Where(g => Aws.L(g.Attachments).Any(a => a.VpcId != null && vpcs.Contains(a.VpcId))).ToList();
        var nats = await Aws.All(ec2.Paginators.DescribeNatGateways(new DescribeNatGatewaysRequest { Filter = byVpc }).NatGateways, ct);

        var prefixLists = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var pl in routeTables.SelectMany(r => Aws.L(r.Routes)).Select(r => r.DestinationPrefixListId).OfType<string>().Distinct())
        {
            var entries = await Fetch.Optional(
                () => Aws.All(ec2.Paginators.GetManagedPrefixListEntries(new GetManagedPrefixListEntriesRequest { PrefixListId = pl }).Entries, ct),
                new List<PrefixListEntry>(), warnings, $"prefix list {pl} entries");
            prefixLists[pl] = entries.Select(e => e.Cidr).OfType<string>().ToList();
        }

        var part = CoreNetworkNormalizer.Normalize(ctx, new CoreNetworkData(vpcList, subnets, routeTables, acls, igws, eigws, nats, prefixLists));
        part.Warnings.AddRange(warnings);
        return part;
    }
}

public sealed class InterfacesCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.Interfaces;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ec2 = await aws.Ec2(ct);
        var byVpc = Fetch.F("vpc-id", ctx.MemberVpcIds);

        var enis = await Aws.All(ec2.Paginators.DescribeNetworkInterfaces(new DescribeNetworkInterfacesRequest { Filters = byVpc }).NetworkInterfaces, ct);
        var sgs = await Aws.All(ec2.Paginators.DescribeSecurityGroups(new DescribeSecurityGroupsRequest { Filters = byVpc }).SecurityGroups, ct);

        var rules = new List<SecurityGroupRule>();
        foreach (var chunk in Fetch.Chunks(sgs.Select(s => s.GroupId)))
            rules.AddRange(await Aws.All(ec2.Paginators.DescribeSecurityGroupRules(new DescribeSecurityGroupRulesRequest { Filters = Fetch.F("group-id", chunk) }).SecurityGroupRules, ct));

        var instances = new List<Instance>();
        foreach (var chunk in Fetch.Chunks(enis.Select(e => e.Attachment?.InstanceId).OfType<string>()))
            foreach (var r in await Aws.All(ec2.Paginators.DescribeInstances(new DescribeInstancesRequest { Filters = Fetch.F("instance-id", chunk) }).Reservations, ct))
                instances.AddRange(Aws.L(r.Instances));

        return InterfacesNormalizer.Normalize(ctx, new InterfacesData(enis, sgs, rules, instances));
    }
}

public sealed class EndpointsCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.Endpoints;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ec2 = await aws.Ec2(ct);
        var warnings = new List<string>();
        var endpoints = await Aws.All(ec2.Paginators.DescribeVpcEndpoints(new DescribeVpcEndpointsRequest { Filters = Fetch.F("vpc-id", ctx.MemberVpcIds) }).VpcEndpoints, ct);

        // Network Firewall is optional: not subscribed / not permitted degrades to "no firewalls" plus a warning.
        var firewalls = await Fetch.Optional(async () =>
        {
            var nfw = await aws.NetworkFirewall(ct);
            var found = new List<(Firewall, FirewallStatus?)>();
            foreach (var meta in await Aws.All(nfw.Paginators.ListFirewalls(new ListFirewallsRequest { VpcIds = ctx.MemberVpcIds.ToList() }).Firewalls, ct))
            {
                var d = await nfw.DescribeFirewallAsync(new DescribeFirewallRequest { FirewallArn = meta.FirewallArn }, ct);
                if (d.Firewall != null) found.Add((d.Firewall, d.FirewallStatus));
            }
            return found;
        }, new List<(Firewall, FirewallStatus?)>(), warnings, "network firewall");

        var part = EndpointsNormalizer.Normalize(ctx, new EndpointsData(endpoints, firewalls));
        part.Warnings.AddRange(warnings);
        return part;
    }
}

public sealed class PeeringCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.Peering;
    private static readonly HashSet<string> Gone = new() { "deleted", "rejected", "failed", "expired" };

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ec2 = await aws.Ec2(ct);
        var all = new Dictionary<string, VpcPeeringConnection>(StringComparer.Ordinal);
        foreach (var filter in new[] { "requester-vpc-info.vpc-id", "accepter-vpc-info.vpc-id" })
            foreach (var p in await Aws.All(ec2.Paginators.DescribeVpcPeeringConnections(new DescribeVpcPeeringConnectionsRequest { Filters = Fetch.F(filter, ctx.MemberVpcIds) }).VpcPeeringConnections, ct))
                if (!Gone.Contains(p.Status?.Code?.Value ?? "")) all[p.VpcPeeringConnectionId] = p;
        return PeeringNormalizer.Normalize(ctx, new PeeringData(all.Values.ToList()));
    }
}

public sealed class FlowLogsCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.FlowLogs;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ec2 = await aws.Ec2(ct);
        var resourceIds = ctx.MemberVpcIds
            .Concat(ctx.PriorNodes(NodeKinds.Subnet).Where(n => n.Visibility == Visibilities.Full).Select(n => n.NativeId))
            .Concat(ctx.PriorNodes(NodeKinds.NetworkInterface).Select(n => n.NativeId));
        var logs = new List<FlowLog>();
        foreach (var chunk in Fetch.Chunks(resourceIds))
            logs.AddRange(await Aws.All(ec2.Paginators.DescribeFlowLogs(new DescribeFlowLogsRequest { Filter = Fetch.F("resource-id", chunk) }).FlowLogs, ct));
        return FlowLogsNormalizer.Normalize(ctx, new FlowLogsData(logs));
    }
}
