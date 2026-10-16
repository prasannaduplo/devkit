using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class PeeringAndFlowLogsTests
{
    [Fact]
    public void Peering_links_both_networks_and_stubs_the_far_side_with_its_cidrs()
    {
        var data = new PeeringData(new()
        {
            new VpcPeeringConnection
            {
                VpcPeeringConnectionId = "pcx-1", Status = new VpcPeeringConnectionStateReason { Code = VpcPeeringConnectionStateReasonCode.Active },
                RequesterVpcInfo = new VpcPeeringConnectionVpcInfo { VpcId = "vpc-1", OwnerId = "111111111111", Region = "us-east-1", CidrBlock = "10.100.0.0/16" },
                AccepterVpcInfo = new VpcPeeringConnectionVpcInfo { VpcId = "vpc-far", OwnerId = "333333333333", Region = "us-west-2", CidrBlock = "10.99.0.0/16" },
            },
        });

        var p = PeeringNormalizer.Normalize(TestCtx.Make(), data);

        var pcx = p.Node(NodeKinds.Peering, "pcx-1", "global");
        pcx.State.Should().Be("available");
        var vpc1Id = TestCtx.Id(NodeKinds.Network, "vpc-1");
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Peers && e.From == vpc1Id && e.To == pcx.Id);
        var far = p.Node(NodeKinds.Network, "vpc-far", region: "us-west-2");
        far.Visibility.Should().Be(Visibilities.Stub);
        far.Cidrs.Should().Equal("10.99.0.0/16");
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Peers && e.From == pcx.Id && e.To == far.Id);
        p.Nodes.Should().NotContain(n => n.Id == vpc1Id);
    }

    [Fact]
    public void Peering_node_id_is_region_independent()
    {
        PeeringData Data() => new(new()
        {
            new VpcPeeringConnection
            {
                VpcPeeringConnectionId = "pcx-9",
                RequesterVpcInfo = new VpcPeeringConnectionVpcInfo { VpcId = "vpc-1", OwnerId = "111111111111", Region = "us-east-1" },
                AccepterVpcInfo = new VpcPeeringConnectionVpcInfo { VpcId = "vpc-2", OwnerId = "111111111111", Region = "us-west-2" },
            },
        });
        var east = PeeringNormalizer.Normalize(TestCtx.Make(vpcIds: new[] { "vpc-1" }, region: "us-east-1"), Data());
        var west = PeeringNormalizer.Normalize(TestCtx.Make(vpcIds: new[] { "vpc-2" }, region: "us-west-2"), Data());
        var expected = AwsIds.Of("global", NodeKinds.Peering, "pcx-9");
        east.Nodes.Single(n => n.Kind == NodeKinds.Peering).Id.Should().Be(expected);
        west.Nodes.Single(n => n.Kind == NodeKinds.Peering).Id.Should().Be(expected);
    }

    [Fact]
    public void Flow_logs_attach_to_their_resource_with_level_and_destination()
    {
        var data = new FlowLogsData(new()
        {
            new FlowLog { FlowLogId = "fl-vpc", ResourceId = "vpc-1", TrafficType = TrafficType.ALL, LogDestinationType = LogDestinationType.S3, LogDestination = "arn:aws:s3:::flow-bucket", FlowLogStatus = "ACTIVE" },
            new FlowLog { FlowLogId = "fl-sub", ResourceId = "subnet-1", TrafficType = TrafficType.REJECT, LogDestinationType = LogDestinationType.CloudWatchLogs, LogGroupName = "/flow/sub" },
        });

        var p = FlowLogsNormalizer.Normalize(TestCtx.Make(), data);

        var vpcLog = p.Node(NodeKinds.FlowLogConfig, "fl-vpc");
        vpcLog.AttrString("level").Should().Be("network");
        vpcLog.AttrString("destination").Should().Be("arn:aws:s3:::flow-bucket");
        var vpcId = TestCtx.Id(NodeKinds.Network, "vpc-1");
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Associated && e.From == vpcId && e.To == vpcLog.Id);
        var subLog = p.Node(NodeKinds.FlowLogConfig, "fl-sub");
        subLog.AttrString("level").Should().Be("subnet");
        subLog.AttrString("destination").Should().Be("/flow/sub");
        var subId = TestCtx.Id(NodeKinds.Subnet, "subnet-1");
        p.Edges.Should().Contain(e => e.From == subId && e.To == subLog.Id);
    }
}
