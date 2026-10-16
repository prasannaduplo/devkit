using Amazon.Route53;
using Amazon.Route53.Model;
using Amazon.Route53Resolver;
using Amazon.Route53Resolver.Model;
using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class DnsNormalizerTests
{
    [Fact]
    public void Resolver_rules_endpoints_and_query_logs_attach_to_member_networks_only()
    {
        var data = new DnsResolverData(
            Endpoints: new() { new ResolverEndpoint { Id = "rslvr-out-1", Name = "to-onprem", Direction = ResolverEndpointDirection.OUTBOUND, HostVPCId = "vpc-1", SecurityGroupIds = new() { "sg-dns" } },
                               new ResolverEndpoint { Id = "rslvr-out-x", HostVPCId = "vpc-other" } },
            Rules: new() { new ResolverRule { Id = "rslvr-rr-1", Name = "corp", DomainName = "corp.example.", RuleType = RuleTypeOption.FORWARD, ResolverEndpointId = "rslvr-out-1",
                                              TargetIps = new() { new TargetAddress { Ip = "192.0.2.53", Port = 53 } } } },
            RuleAssociations: new() { new ResolverRuleAssociation { Id = "rslvr-rrassoc-1", ResolverRuleId = "rslvr-rr-1", VPCId = "vpc-1" } },
            QueryLogAssociations: new() { new ResolverQueryLogConfigAssociation { Id = "rqlca-1", ResolverQueryLogConfigId = "rqlc-1", ResourceId = "vpc-1" } });

        var p = DnsResolverNormalizer.Normalize(TestCtx.Make(), data);

        p.Nodes.Count(n => n.Kind == NodeKinds.ResolverEndpoint).Should().Be(1);
        var rule = p.Node(NodeKinds.ResolverRule, "rslvr-rr-1");
        rule.AttrString("domain").Should().Be("corp.example");
        var netId = TestCtx.Id(NodeKinds.Network, "vpc-1");
        var qlId = TestCtx.Id(NodeKinds.DnsQueryLogConfig, "rqlca-1");
        var cidrId = NodeId.Cidr("192.0.2.53/32");
        p.Edges.Should().Contain(e => e.From == netId && e.To == rule.Id && e.Kind == EdgeKinds.Associated);
        p.Edges.Should().Contain(e => e.From == rule.Id && e.To == cidrId && e.Kind == EdgeKinds.ForwardsTo);
        p.Edges.Should().Contain(e => e.From == netId && e.To == qlId);
    }

    [Fact]
    public void Zones_keep_private_records_and_only_public_records_that_resolve_to_our_resources()
    {
        var lbPrior = new PartBuilder("aws.load-balancers", "scope-net", TestCtx.Now);
        var lbId = TestCtx.Id(NodeKinds.LoadBalancer, "arn:lb");
        lbPrior.Node(lbId, NodeKinds.LoadBalancer, "arn:lb", null, TestCtx.Region).Attr("dnsName", "Internal-API-1.elb.us-east-1.amazonaws.com");
        var pipId = TestCtx.Id(NodeKinds.PublicIp, "eipalloc-1");
        lbPrior.Node(pipId, NodeKinds.PublicIp, "eipalloc-1", null, TestCtx.Region).Attr("ip", "203.0.113.10");

        var data = new DnsZonesData(new()
        {
            new HostedZoneInfo("ZPRIV", "corp.internal.", true, new() { ("vpc-1", "us-east-1") }, new()
            {
                new ResourceRecordSet { Name = "db.corp.internal.", Type = RRType.A, ResourceRecords = new() { new ResourceRecord { Value = "10.0.9.9" } } },
                new ResourceRecordSet { Name = "corp.internal.", Type = RRType.SOA },
            }),
            new HostedZoneInfo("ZPUB", "example.com.", false, new(), new()
            {
                new ResourceRecordSet { Name = "api.example.com.", Type = RRType.A, AliasTarget = new AliasTarget { DNSName = "dualstack.internal-api-1.elb.us-east-1.amazonaws.com." } },
                new ResourceRecordSet { Name = "egress.example.com.", Type = RRType.A, ResourceRecords = new() { new ResourceRecord { Value = "203.0.113.10" } } },
                new ResourceRecordSet { Name = "marketing.example.com.", Type = RRType.CNAME, ResourceRecords = new() { new ResourceRecord { Value = "someone-else.net" } } },
            }),
        });

        var p = DnsZonesNormalizer.Normalize(TestCtx.Make(priors: new[] { lbPrior.Build() }, region: "global"), data);

        var priv = p.Nodes.Single(n => n.Kind == NodeKinds.DnsZone && n.NativeId == "ZPRIV");
        priv.Name.Should().Be("corp.internal");
        var vpcId = AwsIds.Of("us-east-1", NodeKinds.Network, "vpc-1");
        p.Edges.Should().Contain(e => e.From == vpcId && e.To == priv.Id);
        var records = p.Nodes.Where(n => n.Kind == NodeKinds.DnsRecord).Select(n => n.Name).ToList();
        records.Should().BeEquivalentTo("db.corp.internal", "api.example.com", "egress.example.com");
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.ResolvesTo && e.To == lbId);
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.ResolvesTo && e.To == pipId);
    }

    [Fact]
    public void Public_zone_without_matching_records_and_private_zone_without_member_vpcs_are_dropped()
    {
        var data = new DnsZonesData(new()
        {
            new HostedZoneInfo("ZPUB2", "other.com.", false, new(), new()
            {
                new ResourceRecordSet { Name = "www.other.com.", Type = RRType.CNAME, ResourceRecords = new() { new ResourceRecord { Value = "elsewhere.net" } } },
            }),
            new HostedZoneInfo("ZPRIV2", "far.internal.", true, new(), new()
            {
                new ResourceRecordSet { Name = "a.far.internal.", Type = RRType.A, ResourceRecords = new() { new ResourceRecord { Value = "10.1.1.1" } } },
            }),
        });

        var p = DnsZonesNormalizer.Normalize(TestCtx.Make(region: "global"), data);

        p.Nodes.Should().NotContain(n => n.Kind == NodeKinds.DnsZone || n.Kind == NodeKinds.DnsRecord);
    }

    [Fact]
    public void Resolver_rule_target_ips_ignore_targets_without_an_ip()
    {
        var data = new DnsResolverData(
            Endpoints: new(),
            Rules: new() { new ResolverRule { Id = "rslvr-rr-2", DomainName = "x.example.", TargetIps = new() { new TargetAddress { Port = 53 }, new TargetAddress { Ip = "192.0.2.54" } } } },
            RuleAssociations: new() { new ResolverRuleAssociation { Id = "a", ResolverRuleId = "rslvr-rr-2", VPCId = "vpc-1" } },
            QueryLogAssociations: new());

        var p = DnsResolverNormalizer.Normalize(TestCtx.Make(), data);

        var rule = p.Node(NodeKinds.ResolverRule, "rslvr-rr-2");
        rule.AttrStrings("targetIps").Should().Equal("192.0.2.54:53");
    }
}
