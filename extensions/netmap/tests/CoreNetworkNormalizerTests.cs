using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class CoreNetworkNormalizerTests
{
    private static CoreNetworkData Data() => new(
        Vpcs: new() { new Vpc { VpcId = "vpc-1", OwnerId = "111111111111", CidrBlock = "10.100.0.0/16", State = VpcState.Available, Tags = new() { new Tag("Name", "egress") },
            CidrBlockAssociationSet = new() { new VpcCidrBlockAssociation { CidrBlock = "10.100.0.0/16", CidrBlockState = new VpcCidrBlockState { State = VpcCidrBlockStateCode.Associated } },
                                              new VpcCidrBlockAssociation { CidrBlock = "100.64.0.0/16", CidrBlockState = new VpcCidrBlockState { State = VpcCidrBlockStateCode.Associated } } } } },
        Subnets: new()
        {
            new Subnet { SubnetId = "subnet-pub", VpcId = "vpc-1", CidrBlock = "10.100.101.0/24", AvailabilityZone = "us-east-1a", Tags = new() { new Tag("Name", "public-1a") } },
            new Subnet { SubnetId = "subnet-priv", VpcId = "vpc-1", CidrBlock = "10.100.1.0/24", AvailabilityZone = "us-east-1a" },
            new Subnet { SubnetId = "subnet-main", VpcId = "vpc-1", CidrBlock = "10.100.9.0/24", AvailabilityZone = "us-east-1b" },
        },
        RouteTables: new()
        {
            new RouteTable { RouteTableId = "rtb-pub", VpcId = "vpc-1", Associations = new() { new RouteTableAssociation { SubnetId = "subnet-pub" } },
                Routes = new() { new Route { DestinationCidrBlock = "10.100.0.0/16", GatewayId = "local" }, new Route { DestinationCidrBlock = "0.0.0.0/0", GatewayId = "igw-1", State = RouteState.Active } } },
            new RouteTable { RouteTableId = "rtb-priv", VpcId = "vpc-1", Associations = new() { new RouteTableAssociation { SubnetId = "subnet-priv" } },
                Routes = new()
                {
                    new Route { DestinationCidrBlock = "0.0.0.0/0", NatGatewayId = "nat-1", State = RouteState.Active },
                    new Route { DestinationCidrBlock = "10.0.0.0/8", TransitGatewayId = "tgw-1", State = RouteState.Active },
                    new Route { DestinationPrefixListId = "pl-1", VpcPeeringConnectionId = "pcx-1", State = RouteState.Blackhole },
                } },
            new RouteTable { RouteTableId = "rtb-main", VpcId = "vpc-1", Associations = new() { new RouteTableAssociation { Main = true } }, Routes = new() },
        },
        NetworkAcls: new() { new NetworkAcl { NetworkAclId = "acl-1", VpcId = "vpc-1", IsDefault = true, Associations = new() { new NetworkAclAssociation { SubnetId = "subnet-pub" } } } },
        InternetGateways: new() { new InternetGateway { InternetGatewayId = "igw-1", Attachments = new() { new InternetGatewayAttachment { VpcId = "vpc-1", State = AttachmentStatus.Attached } } } },
        EgressOnlyGateways: new(),
        NatGateways: new() { new NatGateway { NatGatewayId = "nat-1", VpcId = "vpc-1", SubnetId = "subnet-pub", State = NatGatewayState.Available, ConnectivityType = ConnectivityType.Public,
            NatGatewayAddresses = new() { new NatGatewayAddress { PublicIp = "203.0.113.10", PrivateIp = "10.100.101.5", AllocationId = "eipalloc-1" } } } },
        PrefixLists: new() { ["pl-1"] = new() { "192.0.2.0/24" } });

    [Fact]
    public void Network_has_name_all_associated_cidrs_and_account_parent()
    {
        var p = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Data());
        var vpc = p.Node(NodeKinds.Network, "vpc-1");
        vpc.Name.Should().Be("egress");
        vpc.Cidrs.Should().Equal("10.100.0.0/16", "100.64.0.0/16");
        vpc.ParentId.Should().Be("aws:-:global:account:111111111111");
        vpc.State.Should().Be("available");
        vpc.Raw.Should().NotBeNull();
    }

    [Fact]
    public void Subnets_are_classified_public_private_and_fall_back_to_the_main_route_table()
    {
        var p = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Data());
        p.Node(NodeKinds.Subnet, "subnet-pub").AttrBool("isPublic").Should().BeTrue();
        p.Node(NodeKinds.Subnet, "subnet-priv").AttrBool("isPublic").Should().BeFalse();

        var implicitEdge = p.EdgesFrom(TestCtx.Id(NodeKinds.Subnet, "subnet-main"), EdgeKinds.Associated).Single();
        implicitEdge.To.Should().Be(TestCtx.Id(NodeKinds.RouteTable, "rtb-main"));
        implicitEdge.Attrs.Should().ContainKey("implicit");
        p.Node(NodeKinds.Subnet, "subnet-pub").Attrs["az"]!.GetValue<string>().Should().Be("us-east-1a");
    }

    [Fact]
    public void Routes_point_at_typed_targets_skip_local_and_resolve_prefix_lists()
    {
        var p = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Data());

        p.EdgesFrom(TestCtx.Id(NodeKinds.RouteTable, "rtb-pub"), EdgeKinds.RoutesTo).Select(e => e.To)
            .Should().Equal(TestCtx.Id(NodeKinds.InternetGateway, "igw-1"));

        var priv = p.EdgesFrom(TestCtx.Id(NodeKinds.RouteTable, "rtb-priv"), EdgeKinds.RoutesTo).ToList();
        priv.Select(e => e.To).Should().BeEquivalentTo(
            TestCtx.Id(NodeKinds.NatGateway, "nat-1"), TestCtx.Id(NodeKinds.Hub, "tgw-1"), TestCtx.Id(NodeKinds.Peering, "pcx-1", "global"));
        var pl = priv.Single(e => e.To.EndsWith("pcx-1"));
        pl.AttrString("state").Should().Be("blackhole");
        pl.AttrString("destination").Should().Be("pl-1");
        pl.Attrs["prefixListCidrs"]!.AsArray().Select(x => x!.GetValue<string>()).Should().Equal("192.0.2.0/24");
    }

    [Fact]
    public void Igw_nat_eip_and_nacl_are_wired()
    {
        var p = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Data());

        p.EdgesFrom(TestCtx.Id(NodeKinds.Network, "vpc-1"), EdgeKinds.Attaches).Select(e => e.To)
            .Should().Contain(TestCtx.Id(NodeKinds.InternetGateway, "igw-1"));
        var nat = p.Node(NodeKinds.NatGateway, "nat-1");
        nat.ParentId.Should().Be(TestCtx.Id(NodeKinds.Subnet, "subnet-pub"));
        nat.AttrString("connectivityType").Should().Be("public");
        var pip = p.Node(NodeKinds.PublicIp, "eipalloc-1");
        pip.Name.Should().Be("203.0.113.10");
        p.EdgesFrom(nat.Id, EdgeKinds.ExitsVia).Single().To.Should().Be(pip.Id);
        p.EdgesFrom(TestCtx.Id(NodeKinds.Subnet, "subnet-pub"), EdgeKinds.Associated).Select(e => e.To)
            .Should().Contain(TestCtx.Id(NodeKinds.Nacl, "acl-1"));
    }

    private static CoreNetworkData Mini(Route[] routes, Vpc? vpc = null, Subnet? subnet = null) => new(
        Vpcs: new() { vpc ?? new Vpc { VpcId = "vpc-1", CidrBlock = "10.1.0.0/16" } },
        Subnets: new() { subnet ?? new Subnet { SubnetId = "subnet-x", VpcId = "vpc-1", CidrBlock = "10.1.1.0/24" } },
        RouteTables: new() { new RouteTable { RouteTableId = "rtb-x", VpcId = "vpc-1", Associations = new() { new RouteTableAssociation { SubnetId = "subnet-x" } }, Routes = routes.ToList() } },
        NetworkAcls: new(), InternetGateways: new(), EgressOnlyGateways: new(), NatGateways: new(), PrefixLists: new());

    [Fact]
    public void Subnet_is_public_only_with_a_default_route_to_an_active_igw()
    {
        var narrow = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Mini(new[] { new Route { DestinationCidrBlock = "10.0.0.0/8", GatewayId = "igw-1", State = RouteState.Active } }));
        narrow.Node(NodeKinds.Subnet, "subnet-x").AttrBool("isPublic").Should().BeFalse();

        var dead = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Mini(new[] { new Route { DestinationCidrBlock = "0.0.0.0/0", GatewayId = "igw-1", State = RouteState.Blackhole } }));
        dead.Node(NodeKinds.Subnet, "subnet-x").AttrBool("isPublic").Should().BeFalse();

        var v6 = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Mini(new[] { new Route { DestinationIpv6CidrBlock = "::/0", GatewayId = "igw-1", State = RouteState.Active } }));
        v6.Node(NodeKinds.Subnet, "subnet-x").AttrBool("isPublic").Should().BeTrue();
    }

    [Fact]
    public void Disassociated_ipv6_blocks_are_excluded()
    {
        var vpc = new Vpc { VpcId = "vpc-1", CidrBlock = "10.1.0.0/16", Ipv6CidrBlockAssociationSet = new()
        {
            new VpcIpv6CidrBlockAssociation { Ipv6CidrBlock = "2001:db8:1::/56", Ipv6CidrBlockState = new VpcCidrBlockState { State = VpcCidrBlockStateCode.Associated } },
            new VpcIpv6CidrBlockAssociation { Ipv6CidrBlock = "2001:db8:2::/56", Ipv6CidrBlockState = new VpcCidrBlockState { State = VpcCidrBlockStateCode.Disassociated } } } };
        var subnet = new Subnet { SubnetId = "subnet-x", VpcId = "vpc-1", CidrBlock = "10.1.1.0/24", Ipv6CidrBlockAssociationSet = new()
        {
            new SubnetIpv6CidrBlockAssociation { Ipv6CidrBlock = "2001:db8:1:1::/64", Ipv6CidrBlockState = new SubnetCidrBlockState { State = SubnetCidrBlockStateCode.Associated } },
            new SubnetIpv6CidrBlockAssociation { Ipv6CidrBlock = "2001:db8:1:2::/64", Ipv6CidrBlockState = new SubnetCidrBlockState { State = SubnetCidrBlockStateCode.Disassociated } } } };
        var p = CoreNetworkNormalizer.Normalize(TestCtx.Make(), Mini(Array.Empty<Route>(), vpc, subnet));
        p.Node(NodeKinds.Network, "vpc-1").Cidrs.Should().Equal("10.1.0.0/16", "2001:db8:1::/56");
        p.Node(NodeKinds.Subnet, "subnet-x").Cidrs.Should().Equal("10.1.1.0/24", "2001:db8:1:1::/64");
    }
}
