using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class TransitNormalizerTests
{
    private static TransitGatewayAttachment Att(string id, string type, string resourceId, string owner = "111111111111", string? name = null) => new()
    {
        TransitGatewayAttachmentId = id, TransitGatewayId = "tgw-1", TransitGatewayOwnerId = "111111111111", ResourceOwnerId = owner,
        ResourceType = new TransitGatewayAttachmentResourceType(type), ResourceId = resourceId, State = TransitGatewayAttachmentState.Available,
        Tags = name == null ? null : new() { new Tag("Name", name) },
    };

    private static TransitData Data(bool readable) => new(
        Gateways: new() { new TransitGateway { TransitGatewayId = "tgw-1", OwnerId = "111111111111", State = TransitGatewayState.Available, Tags = new() { new Tag("Name", "egress-tgw") } } },
        Attachments: new()
        {
            Att("tgw-attach-egress", "vpc", "vpc-1"),
            Att("tgw-attach-spoke", "vpc", "vpc-spoke", owner: "222222222222", name: "shared-services"),
            Att("tgw-attach-vpn", "vpn", "vpn-1"),
            Att("tgw-attach-peer", "peering", "tgw-partner"),
        },
        PeeringAttachments: new() { new TransitGatewayPeeringAttachment { TransitGatewayAttachmentId = "tgw-attach-peer",
            RequesterTgwInfo = new PeeringTgwInfo { TransitGatewayId = "tgw-1", OwnerId = "111111111111", Region = "us-east-1" },
            AccepterTgwInfo = new PeeringTgwInfo { TransitGatewayId = "tgw-partner", OwnerId = "333333333333", Region = "us-west-2" } } },
        RouteTables: readable ? new()
        {
            new TgwRouteTableData(
                new TransitGatewayRouteTable { TransitGatewayRouteTableId = "tgw-rtb-1", TransitGatewayId = "tgw-1", DefaultAssociationRouteTable = true },
                Associations: new() { new TransitGatewayRouteTableAssociation { TransitGatewayAttachmentId = "tgw-attach-spoke" } },
                Propagations: new() { new TransitGatewayRouteTablePropagation { TransitGatewayAttachmentId = "tgw-attach-vpn" } },
                Routes: new()
                {
                    new TransitGatewayRoute { DestinationCidrBlock = "0.0.0.0/0", State = TransitGatewayRouteState.Active, Type = TransitGatewayRouteType.Static,
                        TransitGatewayAttachments = new() { new TransitGatewayRouteAttachment { TransitGatewayAttachmentId = "tgw-attach-egress" } } },
                    new TransitGatewayRoute { DestinationCidrBlock = "10.77.1.0/24", State = TransitGatewayRouteState.Blackhole, Type = TransitGatewayRouteType.Static },
                }),
        } : new(),
        ReadableHubs: readable ? new() { "tgw-1" } : new());

    [Fact]
    public void Hub_is_full_only_when_its_route_tables_were_readable()
    {
        var full = TransitNormalizer.Normalize(TestCtx.Make(), Data(readable: true)).Node(NodeKinds.Hub, "tgw-1");
        full.Visibility.Should().Be(Visibilities.Full);
        var partial = TransitNormalizer.Normalize(TestCtx.Make(), Data(readable: false)).Node(NodeKinds.Hub, "tgw-1");
        partial.Visibility.Should().Be(Visibilities.Partial);
        partial.Name.Should().Be("egress-tgw");
    }

    [Fact]
    public void Every_attachment_type_is_kept_and_wired_to_its_resource()
    {
        var p = TransitNormalizer.Normalize(TestCtx.Make(), Data(readable: true));
        p.Nodes.Count(n => n.Kind == NodeKinds.HubAttachment).Should().Be(4);
        var vpc1 = TestCtx.Id(NodeKinds.Network, "vpc-1");
        var vpn1 = TestCtx.Id(NodeKinds.VpnConnection, "vpn-1");
        var attEgress = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-egress");
        var attVpn = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-vpn");
        var attPeer = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-peer");
        p.Edges.Should().Contain(e => e.From == vpc1 && e.To == attEgress);
        p.Edges.Should().Contain(e => e.From == vpn1 && e.To == attVpn);

        var peer = p.Node(NodeKinds.Hub, "tgw-partner", region: "us-west-2");
        peer.Visibility.Should().Be(Visibilities.Stub);
        p.EdgesFrom(attPeer, EdgeKinds.Peers).Single().To.Should().Be(peer.Id);
    }

    [Fact]
    public void Non_member_spoke_vpc_is_a_named_stub_in_its_owner_account()
    {
        var p = TransitNormalizer.Normalize(TestCtx.Make(), Data(readable: true));
        var spoke = p.Node(NodeKinds.Network, "vpc-spoke");
        spoke.Visibility.Should().Be(Visibilities.Stub);
        spoke.Membership.Should().Be(Memberships.Outside);
        spoke.AttrString("nameHint").Should().Be("shared-services");
        spoke.ParentId.Should().Be("aws:-:global:account:222222222222");
        var vpc1 = TestCtx.Id(NodeKinds.Network, "vpc-1");
        p.Nodes.Should().NotContain(n => n.Id == vpc1);   // members come from core-network
    }

    [Fact]
    public void Route_table_has_associations_propagations_routes_and_blackholes()
    {
        var p = TransitNormalizer.Normalize(TestCtx.Make(), Data(readable: true));
        var rt = p.Node(NodeKinds.HubRouteTable, "tgw-rtb-1");
        rt.ParentId.Should().Be(TestCtx.Id(NodeKinds.Hub, "tgw-1"));
        rt.AttrStrings("blackholeRoutes").Should().Equal("10.77.1.0/24");
        var attSpoke = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-spoke");
        var attVpn = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-vpn");
        var attEgress = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-egress");
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Associated && e.From == attSpoke && e.To == rt.Id);
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Propagates && e.From == attVpn && e.To == rt.Id);
        var route = p.EdgesFrom(rt.Id, EdgeKinds.RoutesTo).Single();
        route.To.Should().Be(attEgress);
        route.AttrString("destination").Should().Be("0.0.0.0/0");
        route.AttrString("routeType").Should().Be("static");
    }

    [Fact]
    public void Same_region_peered_hubs_stay_full()
    {
        TransitGateway Gw(string id) => new() { TransitGatewayId = id, OwnerId = "111111111111", State = TransitGatewayState.Available };
        var d = new TransitData(
            Gateways: new() { Gw("tgw-1"), Gw("tgw-2") },
            Attachments: new() { Att("tgw-attach-peer", "tgw-peering", "tgw-2") },
            PeeringAttachments: new() { new TransitGatewayPeeringAttachment { TransitGatewayAttachmentId = "tgw-attach-peer",
                RequesterTgwInfo = new PeeringTgwInfo { TransitGatewayId = "tgw-1", OwnerId = "111111111111", Region = "us-east-1" },
                AccepterTgwInfo = new PeeringTgwInfo { TransitGatewayId = "tgw-2", OwnerId = "111111111111", Region = "us-east-1" } } },
            RouteTables: new(),
            ReadableHubs: new() { "tgw-1", "tgw-2" });
        var p = TransitNormalizer.Normalize(TestCtx.Make(), d);
        var hub2 = p.Node(NodeKinds.Hub, "tgw-2");
        hub2.Visibility.Should().Be(Visibilities.Full);
        hub2.Membership.Should().Be(Memberships.Blueprint);
        p.Node(NodeKinds.Hub, "tgw-1").Visibility.Should().Be(Visibilities.Full);
        var attPeer = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-peer");
        p.EdgesFrom(attPeer, EdgeKinds.Peers).Single().To.Should().Be(hub2.Id);
    }

    [Fact]
    public void Connect_attachment_links_to_its_transport_attachment()
    {
        var d = new TransitData(
            Gateways: new() { new TransitGateway { TransitGatewayId = "tgw-1", OwnerId = "111111111111" } },
            Attachments: new() { Att("tgw-attach-transport", "vpc", "vpc-1"), Att("tgw-attach-connect", "connect", "tgw-attach-transport") },
            PeeringAttachments: new(), RouteTables: new(), ReadableHubs: new());
        var p = TransitNormalizer.Normalize(TestCtx.Make(), d);
        var transport = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-transport");
        var connect = TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-connect");
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Attaches && e.From == connect && e.To == transport);
    }

    [Fact]
    public void Truncated_routes_are_flagged_on_the_route_table_and_warned()
    {
        var d = Data(readable: true);
        d = d with { RouteTables = d.RouteTables.Select(r => r with { Truncated = true }).ToList() };
        var p = TransitNormalizer.Normalize(TestCtx.Make(), d);
        p.Node(NodeKinds.HubRouteTable, "tgw-rtb-1").Attrs["routesTruncated"]!.GetValue<bool>().Should().BeTrue();
        p.Warnings.Should().ContainSingle(w => w.Contains("tgw-rtb-1"));
    }

    [Fact]
    public void Deleted_and_failed_attachments_are_skipped()
    {
        var d = Data(readable: false);
        d.Attachments.Add(new TransitGatewayAttachment { TransitGatewayAttachmentId = "tgw-attach-dead", TransitGatewayId = "tgw-1",
            ResourceType = new TransitGatewayAttachmentResourceType("vpc"), ResourceId = "vpc-1", State = TransitGatewayAttachmentState.Deleted });
        d.Attachments.Add(new TransitGatewayAttachment { TransitGatewayAttachmentId = "tgw-attach-bad", TransitGatewayId = "tgw-1",
            ResourceType = new TransitGatewayAttachmentResourceType("vpc"), ResourceId = "vpc-1", State = TransitGatewayAttachmentState.Failed });
        var p = TransitNormalizer.Normalize(TestCtx.Make(), d);
        p.Nodes.Count(n => n.Kind == NodeKinds.HubAttachment).Should().Be(4);
    }
}
