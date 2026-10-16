using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Tests;

internal static class TestCtx
{
    public static readonly DateTime Now = new(2026, 10, 16, 9, 0, 0, DateTimeKind.Utc);
    public const string Account = "111111111111";
    public const string Region = "us-east-1";

    public static CollectorContext Make(IEnumerable<string>? vpcIds = null, IEnumerable<GraphPart>? priors = null,
        string scope = "scope-net", string account = Account, string region = Region)
    {
        var vpcs = (vpcIds ?? new[] { "vpc-1" }).ToList();
        var members = vpcs.Select(v => new BlueprintMember { ScopeId = scope, Region = region, NetworkId = v }).ToList();
        return new CollectorContext(scope, account, region, vpcs, members, (priors ?? Enumerable.Empty<GraphPart>()).ToList(), Now);
    }

    public static string Id(string kind, string nativeId, string region = Region) => AwsIds.Of(region, kind, nativeId);

    public static GraphNode Node(this GraphPart p, string kind, string nativeId, string region = Region) =>
        p.Nodes.Single(n => n.Id == Id(kind, nativeId, region));

    public static IEnumerable<GraphEdge> EdgesFrom(this GraphPart p, string id, string kind) => p.Edges.Where(e => e.From == id && e.Kind == kind);
}
