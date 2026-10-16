using Amazon.ElasticLoadBalancingV2;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;
using Elb = Amazon.ElasticLoadBalancing.Model;
using V2 = Amazon.ElasticLoadBalancingV2.Model;

namespace Duplo.Extension.NetMap.Tests;

public class LoadBalancerNormalizerTests
{
    private const string Arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/net/internal-api/50dc6c495c0c9188";
    private const string TgArn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/api/abc";

    private static GraphPart InterfacesPrior()
    {
        var b = new PartBuilder("aws.interfaces", "scope-net", TestCtx.Now);
        b.Node(TestCtx.Id(NodeKinds.NetworkInterface, "eni-nlb"), NodeKinds.NetworkInterface, "eni-nlb", null, TestCtx.Region)
            .Attr("description", "ELB net/internal-api/50dc6c495c0c9188");
        b.Node(TestCtx.Id(NodeKinds.NetworkInterface, "eni-pod"), NodeKinds.NetworkInterface, "eni-pod", null, TestCtx.Region)
            .Attr("privateIps", NodeExtensions.Arr(new[] { "10.0.1.50" }));
        return b.Build();
    }

    private static GraphPart OverlapPrior()
    {
        var b = new PartBuilder("aws.interfaces", "scope-net", TestCtx.Now);
        b.Node(TestCtx.Id(NodeKinds.NetworkInterface, "eni-other"), NodeKinds.NetworkInterface, "eni-other", null, TestCtx.Region)
            .Attr("vpcId", "vpc-other").Attr("privateIps", NodeExtensions.Arr(new[] { "10.0.1.50" }));
        b.Node(TestCtx.Id(NodeKinds.NetworkInterface, "eni-mine"), NodeKinds.NetworkInterface, "eni-mine", null, TestCtx.Region)
            .Attr("vpcId", "vpc-1").Attr("privateIps", NodeExtensions.Arr(new[] { "10.0.1.50" }));
        return b.Build();
    }

    [Fact]
    public void Ip_targets_prefer_interface_in_the_lbs_vpc()
    {
        var p = LoadBalancerNormalizer.Normalize(TestCtx.Make(priors: new[] { OverlapPrior() }), Data());
        var mine = TestCtx.Id(NodeKinds.NetworkInterface, "eni-mine");
        var other = TestCtx.Id(NodeKinds.NetworkInterface, "eni-other");
        var tos = p.EdgesFrom(TestCtx.Id(NodeKinds.LoadBalancer, Arn), EdgeKinds.Targets).Select(t => t.To).ToList();
        tos.Should().Contain(mine);
        tos.Should().NotContain(other);
    }

    [Fact]
    public void Ipv6_target_without_interface_falls_back_to_slash_128()
    {
        var d = Data();
        d.TargetHealth[TgArn].Add(new V2.TargetHealthDescription { Target = new V2.TargetDescription { Id = "2001:db8::5", Port = 8443 }, TargetHealth = new V2.TargetHealth { State = TargetHealthStateEnum.Healthy } });
        var p = LoadBalancerNormalizer.Normalize(TestCtx.Make(), d);
        var cidr = NodeId.Cidr("2001:db8::5/128");
        p.EdgesFrom(TestCtx.Id(NodeKinds.LoadBalancer, Arn), EdgeKinds.Targets).Select(t => t.To).Should().Contain(cidr);
    }

    private static LoadBalancerData Data() => new(
        LoadBalancers: new() { new V2.LoadBalancer { LoadBalancerArn = Arn, LoadBalancerName = "internal-api", DNSName = "internal-api-123.elb.us-east-1.amazonaws.com",
            Scheme = LoadBalancerSchemeEnum.Internal, Type = LoadBalancerTypeEnum.Network, VpcId = "vpc-1",
            AvailabilityZones = new() { new V2.AvailabilityZone { SubnetId = "subnet-1", ZoneName = "us-east-1a" } }, SecurityGroups = new() { "sg-nlb" } } },
        Listeners: new() { new V2.Listener { LoadBalancerArn = Arn, Port = 443, Protocol = ProtocolEnum.TCP } },
        TargetGroups: new() { new V2.TargetGroup { TargetGroupArn = TgArn, TargetGroupName = "api", Port = 8443, Protocol = ProtocolEnum.TCP, LoadBalancerArns = new() { Arn } } },
        TargetHealth: new() { [TgArn] = new() {
            new V2.TargetHealthDescription { Target = new V2.TargetDescription { Id = "10.0.1.50", Port = 8443 }, TargetHealth = new V2.TargetHealth { State = TargetHealthStateEnum.Healthy } },
            new V2.TargetHealthDescription { Target = new V2.TargetDescription { Id = "i-web", Port = 8443 }, TargetHealth = new V2.TargetHealth { State = TargetHealthStateEnum.Unhealthy } } } },
        Tags: new() { [Arn] = new() { new V2.Tag { Key = "app", Value = "payments" } } },
        Classic: new() { new Elb.LoadBalancerDescription { LoadBalancerName = "legacy", DNSName = "legacy.elb.amazonaws.com", Scheme = "internet-facing", VPCId = "vpc-1",
            Subnets = new() { "subnet-1" }, Instances = new() { new Elb.Instance { InstanceId = "i-old" } } } });

    [Fact]
    public void Nlb_has_scheme_listeners_placement_and_its_own_interfaces()
    {
        var p = LoadBalancerNormalizer.Normalize(TestCtx.Make(priors: new[] { InterfacesPrior() }), Data());
        var lb = p.Node(NodeKinds.LoadBalancer, Arn);
        lb.Name.Should().Be("internal-api");
        lb.AttrString("scheme").Should().Be("internal");
        lb.AttrString("lbType").Should().Be("network");
        lb.Tags["app"].Should().Be("payments");
        lb.Attrs["listeners"]!.AsArray().Single()!["port"]!.GetValue<int>().Should().Be(443);
        p.EdgesFrom(lb.Id, EdgeKinds.PlacedIn).Single().To.Should().Be(TestCtx.Id(NodeKinds.Subnet, "subnet-1"));
        p.EdgesFrom(lb.Id, EdgeKinds.Attaches).Single().To.Should().Be(TestCtx.Id(NodeKinds.NetworkInterface, "eni-nlb"));
    }

    [Fact]
    public void Targets_resolve_ips_to_interfaces_and_instances_to_workloads()
    {
        var p = LoadBalancerNormalizer.Normalize(TestCtx.Make(priors: new[] { InterfacesPrior() }), Data());
        var targets = p.EdgesFrom(TestCtx.Id(NodeKinds.LoadBalancer, Arn), EdgeKinds.Targets).ToList();
        targets.Select(t => t.To).Should().BeEquivalentTo(TestCtx.Id(NodeKinds.NetworkInterface, "eni-pod"), TestCtx.Id(NodeKinds.Workload, "i-web"));
        targets.Single(t => t.To.EndsWith("i-web")).AttrString("health").Should().Be("unhealthy");
    }

    [Fact]
    public void Classic_elb_is_included()
    {
        var p = LoadBalancerNormalizer.Normalize(TestCtx.Make(), Data());
        var c = p.Node(NodeKinds.LoadBalancer, "classic/legacy");
        c.AttrString("lbType").Should().Be("classic");
        p.EdgesFrom(c.Id, EdgeKinds.Targets).Single().To.Should().Be(TestCtx.Id(NodeKinds.Workload, "i-old"));
    }
}
