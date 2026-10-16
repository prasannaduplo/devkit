using Amazon.EC2.Model;
using Amazon.Runtime;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Fetch;

public sealed class TransitCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.Transit;
    private const int RouteSearchMax = 1000;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ec2 = await aws.Ec2(ct);
        var warnings = new List<string>();
        var memberAttachments = new List<TransitGatewayAttachment>();
        foreach (var chunk in Fetch.Chunks(ctx.MemberVpcIds))
            memberAttachments.AddRange(await Aws.All(ec2.Paginators.DescribeTransitGatewayAttachments(
                new DescribeTransitGatewayAttachmentsRequest { Filters = Fetch.F("resource-id", chunk) }).TransitGatewayAttachments, ct));
        var tgwIds = memberAttachments.Select(a => a.TransitGatewayId).OfType<string>().Distinct().ToList();
        if (tgwIds.Count == 0)
            return TransitNormalizer.Normalize(ctx, new TransitData(new(), new(), new(), new(), new()));

        var gateways = new List<TransitGateway>();
        var attachments = new List<TransitGatewayAttachment>();
        var peerings = new List<TransitGatewayPeeringAttachment>();
        foreach (var chunk in Fetch.Chunks(tgwIds))
        {
            var byTgw = Fetch.F("transit-gateway-id", chunk);
            gateways.AddRange(await Aws.All(ec2.Paginators.DescribeTransitGateways(new DescribeTransitGatewaysRequest { Filters = byTgw }).TransitGateways, ct));
            attachments.AddRange(await Aws.All(ec2.Paginators.DescribeTransitGatewayAttachments(new DescribeTransitGatewayAttachmentsRequest { Filters = byTgw }).TransitGatewayAttachments, ct));
            peerings.AddRange(await Aws.All(ec2.Paginators.DescribeTransitGatewayPeeringAttachments(new DescribeTransitGatewayPeeringAttachmentsRequest { Filters = byTgw }).TransitGatewayPeeringAttachments, ct));
        }
        foreach (var a in memberAttachments.Where(m => attachments.All(x => x.TransitGatewayAttachmentId != m.TransitGatewayAttachmentId)))
            attachments.Add(a);   // a spoke account only lists its own attachments -- keep them

        // Route tables are readable only by the TGW owner. A non-owner (or missing permission) leaves the hub partial
        // instead of failing the unit; any other error (throttling included) propagates so the engine retries.
        // A TGW counts as readable only when ALL its tables were fetched.
        var tables = new List<TgwRouteTableData>();
        var readable = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tgw in tgwIds)
        {
            var tgwTables = new List<TgwRouteTableData>();
            try
            {
                var rts = await Aws.All(ec2.Paginators.DescribeTransitGatewayRouteTables(
                    new DescribeTransitGatewayRouteTablesRequest { Filters = Fetch.F("transit-gateway-id", new[] { tgw }) }).TransitGatewayRouteTables, ct);
                foreach (var rt in rts)
                {
                    var assoc = await Aws.All(ec2.Paginators.GetTransitGatewayRouteTableAssociations(
                        new GetTransitGatewayRouteTableAssociationsRequest { TransitGatewayRouteTableId = rt.TransitGatewayRouteTableId }).Associations, ct);
                    var props = await Aws.All(ec2.Paginators.GetTransitGatewayRouteTablePropagations(
                        new GetTransitGatewayRouteTablePropagationsRequest { TransitGatewayRouteTableId = rt.TransitGatewayRouteTableId }).TransitGatewayRouteTablePropagations, ct);

                    // The filter must name the route type; query static and propagated separately (1000 each).
                    var routes = new List<TransitGatewayRoute>();
                    var truncated = false;
                    foreach (var type in new[] { "static", "propagated" })
                    {
                        var resp = await ec2.SearchTransitGatewayRoutesAsync(new SearchTransitGatewayRoutesRequest
                        {
                            TransitGatewayRouteTableId = rt.TransitGatewayRouteTableId,
                            Filters = Fetch.F("type", new[] { type }),
                            MaxResults = RouteSearchMax,
                        }, ct);
                        routes.AddRange(Aws.L(resp.Routes));
                        truncated |= resp.AdditionalRoutesAvailable == true;
                    }
                    tgwTables.Add(new TgwRouteTableData(rt, assoc, props, routes, truncated));
                }
                tables.AddRange(tgwTables);
                if (rts.Count > 0) readable.Add(tgw);
            }
            catch (AmazonServiceException ex) when (Fetch.IsUnavailable(ex))
            {
                warnings.Add($"route tables of {tgw} not readable: {Fetch.Reason(ex)}");
            }
        }

        var part = TransitNormalizer.Normalize(ctx, new TransitData(gateways, attachments, peerings, tables, readable));
        part.Warnings.AddRange(warnings);
        return part;
    }
}

public sealed class VpnCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.Vpn;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ec2 = await aws.Ec2(ct);
        var vgws = new List<VpnGateway>();
        foreach (var chunk in Fetch.Chunks(ctx.MemberVpcIds))
            vgws.AddRange(Aws.L((await ec2.DescribeVpnGatewaysAsync(new DescribeVpnGatewaysRequest { Filters = Fetch.F("attachment.vpc-id", chunk) }, ct)).VpnGateways));
        var hubIds = ctx.PriorNodes(NodeKinds.Hub).Where(h => h.Visibility != Visibilities.Stub).Select(h => h.NativeId).Distinct().ToList();

        var conns = new Dictionary<string, VpnConnection>(StringComparer.Ordinal);
        async Task Add(string filter, IEnumerable<string> ids)
        {
            foreach (var chunk in Fetch.Chunks(ids))
            {
                var resp = await ec2.DescribeVpnConnectionsAsync(new DescribeVpnConnectionsRequest { Filters = Fetch.F(filter, chunk) }, ct);
                foreach (var c in Aws.L(resp.VpnConnections).Where(c => c.State?.Value != "deleted")) conns[c.VpnConnectionId] = c;
            }
        }
        await Add("vpn-gateway-id", vgws.Select(g => g.VpnGatewayId));
        await Add("transit-gateway-id", hubIds);

        var cgwIds = conns.Values.Select(c => c.CustomerGatewayId).OfType<string>().Distinct().ToList();
        var cgws = new List<CustomerGateway>();
        foreach (var chunk in Fetch.Chunks(cgwIds))
            cgws.AddRange(Aws.L((await ec2.DescribeCustomerGatewaysAsync(new DescribeCustomerGatewaysRequest { Filters = Fetch.F("customer-gateway-id", chunk) }, ct)).CustomerGateways));

        return VpnNormalizer.Normalize(ctx, new VpnData(vgws, conns.Values.ToList(), cgws));
    }
}
