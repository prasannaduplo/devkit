using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;
using Nfw = Amazon.NetworkFirewall.Model;

namespace Duplo.Extension.NetMap.Tests;

public class EndpointsNormalizerTests
{
    private const string FwArn = "arn:aws:network-firewall:us-east-1:111111111111:firewall/egress-fw";

    private static EndpointsData Data() => new(
        Endpoints: new()
        {
            new VpcEndpoint { VpcEndpointId = "vpce-s3", VpcId = "vpc-1", ServiceName = "com.amazonaws.us-east-1.s3", VpcEndpointType = VpcEndpointType.Gateway, RouteTableIds = new() { "rtb-priv" } },
            new VpcEndpoint { VpcEndpointId = "vpce-gwlb", VpcId = "vpc-1", ServiceName = "com.amazonaws.vpce.us-east-1.vpce-svc-1", VpcEndpointType = VpcEndpointType.GatewayLoadBalancer,
                SubnetIds = new() { "subnet-insp" }, NetworkInterfaceIds = new() { "eni-gwlbe" } },
        },
        Firewalls: new()
        {
            (new Nfw.Firewall { FirewallArn = FwArn, FirewallName = "egress-fw", VpcId = "vpc-1", FirewallPolicyArn = "arn:policy", SubnetMappings = new() { new Nfw.SubnetMapping { SubnetId = "subnet-fw" } } },
             new Nfw.FirewallStatus { SyncStates = new() { ["us-east-1a"] = new Nfw.SyncState { Attachment = new Nfw.Attachment { SubnetId = "subnet-fw", EndpointId = "vpce-nfw" } } } }),
        });

    [Fact]
    public void Gateway_endpoint_is_associated_to_route_tables_and_gwlb_endpoint_placed_in_subnet()
    {
        var p = EndpointsNormalizer.Normalize(TestCtx.Make(), Data());
        var s3 = p.Node(NodeKinds.Endpoint, "vpce-s3");
        s3.Name.Should().Be("s3");
        s3.AttrString("endpointType").Should().Be("Gateway");
        var rtb = TestCtx.Id(NodeKinds.RouteTable, "rtb-priv");
        p.Edges.Should().Contain(e => e.From == rtb && e.To == s3.Id && e.Kind == EdgeKinds.Associated);

        var gwlbe = p.Node(NodeKinds.Endpoint, "vpce-gwlb");
        gwlbe.AttrString("endpointType").Should().Be("GatewayLoadBalancer");
        p.EdgesFrom(gwlbe.Id, EdgeKinds.PlacedIn).Single().To.Should().Be(TestCtx.Id(NodeKinds.Subnet, "subnet-insp"));
        p.EdgesFrom(gwlbe.Id, EdgeKinds.Attaches).Single().To.Should().Be(TestCtx.Id(NodeKinds.NetworkInterface, "eni-gwlbe"));
    }

    [Fact]
    public void Network_firewall_owns_its_service_managed_endpoints()
    {
        var p = EndpointsNormalizer.Normalize(TestCtx.Make(), Data());
        var fw = p.Node(NodeKinds.FirewallService, FwArn);
        fw.Name.Should().Be("egress-fw");
        var ep = p.Node(NodeKinds.Endpoint, "vpce-nfw");
        ep.AttrString("managedBy").Should().Be("network-firewall");
        ep.AttrString("endpointType").Should().Be("GatewayLoadBalancer");
        p.EdgesFrom(fw.Id, EdgeKinds.Attaches).Single().To.Should().Be(ep.Id);
    }
}
