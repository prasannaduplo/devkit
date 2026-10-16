using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record FlowLogsData(List<FlowLog> FlowLogs);

/// <summary>Flow-log CONFIGURATION only (level, traffic type, destination, format) -- feeds the "flow logs
/// available" capability. Log contents are AOS's job, not this extension's.</summary>
public static class FlowLogsNormalizer
{
    public static readonly string Collector = Collectors.FlowLogs.Id;

    public static GraphPart Normalize(CollectorContext ctx, FlowLogsData d)
    {
        var b = ctx.Builder(Collector);
        foreach (var f in d.FlowLogs.Where(f => f.ResourceId != null))
        {
            var kind = AwsIds.KindForPrefix(f.ResourceId);
            var level = kind switch { NodeKinds.Network => "network", NodeKinds.Subnet => "subnet", NodeKinds.NetworkInterface => "interface", _ => "other" };
            var n = b.Node(ctx.Id(NodeKinds.FlowLogConfig, f.FlowLogId), NodeKinds.FlowLogConfig, f.FlowLogId, ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(f.Tags)).Under(ctx.Id(kind, f.ResourceId)).SetState(f.FlowLogStatus)
                .Attr("resourceId", f.ResourceId).Attr("level", level).Attr("trafficType", f.TrafficType?.Value)
                .Attr("destinationType", f.LogDestinationType?.Value).Attr("destination", f.LogDestination ?? f.LogGroupName)
                .Attr("logFormat", f.LogFormat);
            n.Raw = RawJson.From(f);
            b.Edge(ctx.Id(kind, f.ResourceId), EdgeKinds.Associated, n.Id);
        }
        return b.Build();
    }
}
