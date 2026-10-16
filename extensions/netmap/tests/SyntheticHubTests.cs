using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class SyntheticHubTests
{
    private static FinalizeOutput Run() => SnapshotFinalizer.Finalize(new FinalizeInput(
        SyntheticHub.Members, SyntheticHub.BuildUnits(), SyntheticHub.Accounts, SyntheticHub.ScopeNames, TestCtx.Now));

    private static string Id(string kind, string native, string region = SyntheticHub.Region) => AwsIds.Of(region, kind, native);

    [Fact]
    public void Merges_both_scopes_into_one_hub_picture()
    {
        var o = Run();
        var g = o.Graph;

        o.ScanStatus.Should().Be(ScanStatuses.Complete);
        g.Nodes.Count(n => n.Kind == NodeKinds.Hub && n.Visibility == Visibilities.Full).Should().Be(5);
        g.Nodes.Count(n => n.Kind == NodeKinds.Hub && n.Visibility == Visibilities.Stub).Should().Be(2);   // partner + colo peers
        g.Nodes.Count(n => n.Kind == NodeKinds.VpnConnection).Should().Be(10);
        g.Nodes.Count(n => n.Kind == NodeKinds.VpnTunnel).Should().Be(20);

        var egressId = Id(NodeKinds.Hub, "tgw-egress");
        var prodId = Id(NodeKinds.Network, "vpc-prod");
        var masterId = Id(NodeKinds.Network, "vpc-shared-services");
        var opId = Id(NodeKinds.Network, "vpc-spoke-d-east");
        var egressTgw = g.Nodes.Single(n => n.Id == egressId);
        egressTgw.Visibility.Should().Be(Visibilities.Full);
        egressTgw.Name.Should().Be("hub-egress-tgw");
        egressTgw.SeenFrom.Should().BeEquivalentTo(SyntheticHub.NetScope, SyntheticHub.ProdScope);

        var prod = g.Nodes.Single(n => n.Id == prodId);
        prod.Visibility.Should().Be(Visibilities.Full);
        prod.Name.Should().Be("prod-ue1");
        g.Nodes.Single(n => n.Id == masterId).Name.Should().Be("shared-services");
        g.Nodes.Single(n => n.Id == opId).Visibility.Should().Be(Visibilities.Stub);

        g.Nodes.Should().Contain(n => n.Kind == NodeKinds.Account && n.Name == "network-hub · 111111111111");
        g.Nodes.Should().Contain(n => n.Kind == NodeKinds.Account && n.NativeId == SyntheticHub.PeerAccount && n.Visibility == Visibilities.Partial);
    }

    [Fact]
    public void Egress_findings_and_capabilities_match_the_topology()
    {
        var o = Run();
        var subnet = (string s) => { var sid = Id(NodeKinds.Subnet, s); return o.Graph.Nodes.Single(n => n.Id == sid).AttrString("egress"); };

        subnet("subnet-egress-priv-1a").Should().Be("via-nat");
        subnet("subnet-egress-pub-1a").Should().Be("direct");
        subnet("subnet-prod-app-1a").Should().Be("via-hub");

        o.Graph.Findings.Should().ContainSingle(f => f.RuleId == "NET-003").Which.Message.Should().StartWith("Site E 2");
        o.Graph.Findings.Should().ContainSingle(f => f.RuleId == "NET-001").Which.Message.Should().Contain("tcp/22");

        var caps = o.Summary.Capabilities;
        caps[CapabilityKeys.Egress].State.Should().Be(CapabilityStates.Available);
        caps[CapabilityKeys.Vpn].State.Should().Be(CapabilityStates.Partial);
        caps[CapabilityKeys.Transit].State.Should().Be(CapabilityStates.Available);
        caps[CapabilityKeys.FlowLogs].State.Should().Be(CapabilityStates.None);
        o.MemberStatuses.Should().OnlyContain(m => m.Status == MemberStates.Ok);
    }

    [Fact]
    public void Is_deterministic_and_writes_the_plan_2_fixture()
    {
        var a = Run();
        a.ContentHash.Should().Be(Run().ContentHash);

        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../fixtures/generated/synthetic-hub.graph.json"));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, GraphCodec.ToJson(new { graph = a.Graph, summary = a.Summary, members = a.MemberStatuses }));
        new FileInfo(path).Length.Should().BeGreaterThan(10_000);
    }
}
