using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Aws.Fetch;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class DnsZonesMemberFilterTests
{
    [Fact]
    public void Only_members_with_a_full_network_node_in_priors_are_queried()
    {
        var b = new PartBuilder("aws.core-network", "scope-net", TestCtx.Now);
        b.Node(TestCtx.Id(NodeKinds.Network, "vpc-ok"), NodeKinds.Network, "vpc-ok", TestCtx.Account, TestCtx.Region);
        var stub = b.Node(TestCtx.Id(NodeKinds.Network, "vpc-stub"), NodeKinds.Network, "vpc-stub", TestCtx.Account, TestCtx.Region);
        stub.Visibility = Visibilities.Stub;
        var ctx = TestCtx.Make(new[] { "vpc-ok", "vpc-stub", "vpc-missing" }, new[] { b.Build() });

        DnsZonesCollector.MembersToQuery(ctx).Select(m => m.NetworkId).Should().Equal("vpc-ok");
    }

    [Fact]
    public async Task Returns_an_empty_part_without_calling_aws_when_no_member_was_found()
    {
        var ctx = TestCtx.Make(new[] { "vpc-missing" });
        var part = await new DnsZonesCollector().CollectAsync(ctx, new ThrowingAws(), CancellationToken.None);
        part.Nodes.Should().BeEmpty();
        part.Edges.Should().BeEmpty();
    }

    private sealed class ThrowingAws : IAwsClients
    {
        private static Task<T> No<T>() => throw new InvalidOperationException("AWS must not be called");
        public Task<Amazon.EC2.IAmazonEC2> Ec2(CancellationToken ct) => No<Amazon.EC2.IAmazonEC2>();
        public Task<Amazon.ElasticLoadBalancingV2.IAmazonElasticLoadBalancingV2> Elbv2(CancellationToken ct) => No<Amazon.ElasticLoadBalancingV2.IAmazonElasticLoadBalancingV2>();
        public Task<Amazon.ElasticLoadBalancing.IAmazonElasticLoadBalancing> Elb(CancellationToken ct) => No<Amazon.ElasticLoadBalancing.IAmazonElasticLoadBalancing>();
        public Task<Amazon.NetworkFirewall.IAmazonNetworkFirewall> NetworkFirewall(CancellationToken ct) => No<Amazon.NetworkFirewall.IAmazonNetworkFirewall>();
        public Task<Amazon.Route53.IAmazonRoute53> Route53(CancellationToken ct) => No<Amazon.Route53.IAmazonRoute53>();
        public Task<Amazon.Route53Resolver.IAmazonRoute53Resolver> Resolver(CancellationToken ct) => No<Amazon.Route53Resolver.IAmazonRoute53Resolver>();
        public Task<Amazon.EKS.IAmazonEKS> Eks(CancellationToken ct) => No<Amazon.EKS.IAmazonEKS>();
        public Task<Amazon.ECS.IAmazonECS> Ecs(CancellationToken ct) => No<Amazon.ECS.IAmazonECS>();
        public Task<Amazon.Lambda.IAmazonLambda> Lambda(CancellationToken ct) => No<Amazon.Lambda.IAmazonLambda>();
        public Task<Amazon.SecurityToken.IAmazonSecurityTokenService> Sts(CancellationToken ct) => No<Amazon.SecurityToken.IAmazonSecurityTokenService>();
        public Task<Amazon.Runtime.ImmutableCredentials> Credentials(CancellationToken ct) => No<Amazon.Runtime.ImmutableCredentials>();
        public void Dispose() { }
    }
}
