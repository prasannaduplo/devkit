using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Aws;

/// <summary>AWS canonical ids. The account segment is always empty (see NodeId).</summary>
public static class AwsIds
{
    public static string Of(string? region, string kind, string nativeId) => NodeId.For("aws", null, region, kind, nativeId);

    /// <summary>Kind of the object an AWS id refers to, from its prefix -- for route targets and associations that
    /// only carry an id. Order matters: "tgw-attach-" and "tgw-rtb-" before "tgw-".</summary>
    public static string KindForPrefix(string nativeId) => nativeId switch
    {
        _ when nativeId.StartsWith("tgw-attach-", StringComparison.Ordinal) => NodeKinds.HubAttachment,
        _ when nativeId.StartsWith("tgw-rtb-", StringComparison.Ordinal) => NodeKinds.HubRouteTable,
        _ when nativeId.StartsWith("tgw-", StringComparison.Ordinal) => NodeKinds.Hub,
        _ when nativeId.StartsWith("igw-", StringComparison.Ordinal) => NodeKinds.InternetGateway,
        _ when nativeId.StartsWith("eigw-", StringComparison.Ordinal) => NodeKinds.EgressOnlyGateway,
        _ when nativeId.StartsWith("nat-", StringComparison.Ordinal) => NodeKinds.NatGateway,
        _ when nativeId.StartsWith("pcx-", StringComparison.Ordinal) => NodeKinds.Peering,
        _ when nativeId.StartsWith("vgw-", StringComparison.Ordinal) => NodeKinds.VpnGateway,
        _ when nativeId.StartsWith("vpce-", StringComparison.Ordinal) => NodeKinds.Endpoint,
        _ when nativeId.StartsWith("eni-", StringComparison.Ordinal) => NodeKinds.NetworkInterface,
        _ when nativeId.StartsWith("i-", StringComparison.Ordinal) => NodeKinds.Workload,
        _ when nativeId.StartsWith("vpc-", StringComparison.Ordinal) => NodeKinds.Network,
        _ when nativeId.StartsWith("subnet-", StringComparison.Ordinal) => NodeKinds.Subnet,
        _ when nativeId.StartsWith("rtb-", StringComparison.Ordinal) => NodeKinds.RouteTable,
        _ when nativeId.StartsWith("sg-", StringComparison.Ordinal) => NodeKinds.SecurityGroup,
        _ when nativeId.StartsWith("acl-", StringComparison.Ordinal) => NodeKinds.Nacl,
        _ when nativeId.StartsWith("cgw-", StringComparison.Ordinal) => NodeKinds.PeerGateway,
        _ when nativeId.StartsWith("vpn-", StringComparison.Ordinal) => NodeKinds.VpnConnection,
        _ => NodeKinds.OtherGateway,
    };
}

/// <summary>AWS SDK v4 conveniences. v4 leaves unset collections null, hence L().</summary>
public static class Aws
{
    public static List<T> L<T>(List<T>? list) => list ?? new List<T>();

    public static IEnumerable<KeyValuePair<string, string>> Tags(IEnumerable<Amazon.EC2.Model.Tag>? tags) =>
        (tags ?? Enumerable.Empty<Amazon.EC2.Model.Tag>())
            .Where(t => !string.IsNullOrEmpty(t.Key))
            .Select(t => KeyValuePair.Create(t.Key, t.Value ?? ""));

    public static async Task<List<T>> All<T>(Amazon.Runtime.IPaginatedEnumerable<T> pages, CancellationToken ct)
    {
        var list = new List<T>();
        await foreach (var item in pages.WithCancellation(ct)) list.Add(item);
        return list;
    }
}
