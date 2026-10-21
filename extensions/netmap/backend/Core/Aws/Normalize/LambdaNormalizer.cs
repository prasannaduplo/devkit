using System.Text.RegularExpressions;
using Amazon.Lambda.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record LambdaData(List<FunctionConfiguration> Functions);

/// <summary>VPC-attached Lambda functions in member networks (functions without a VpcConfig are skipped). Links: runs-on
/// the ENIs Lambda created for it ("AWS Lambda VPC ENI-&lt;function&gt;-&lt;uuid&gt;"; Hyperplane ENIs are shared per
/// subnet + security-group set, so an ENI named after another function with the same subnet and groups also counts),
/// uses its security groups, placed-in its subnets. Environment variables and code are never stored (no raw).</summary>
public static class LambdaNormalizer
{
    public static readonly string Collector = Collectors.Lambda.Id;

    private static readonly Regex EniDescription = new(@"^AWS Lambda VPC ENI-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.Compiled);

    public static GraphPart Normalize(CollectorContext ctx, LambdaData d)
    {
        var b = ctx.Builder(Collector);
        var links = new WorkloadLinks(ctx);
        var vpcs = ctx.MemberVpcIds.ToHashSet(StringComparer.Ordinal);
        var lambdaEnis = links.Enis.Where(e => e.AttrString("managedBy") == "lambda").Select(e => (Eni: e,
            Fn: EniDescription.Match(e.AttrString("description") ?? "") is { Success: true } m ? m.Groups[1].Value : null,
            Subnet: e.ParentId)).ToList();
        // interface → its security groups come from "uses" edges in the interfaces part
        var eniSgs = ctx.Priors.SelectMany(p => p.Edges).Where(e => e.Kind == EdgeKinds.Uses)
            .GroupBy(e => e.From, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Select(e => e.To).ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);

        foreach (var f in d.Functions)
        {
            var vpc = f.VpcConfig?.VpcId;
            if (string.IsNullOrEmpty(vpc) || !vpcs.Contains(vpc)) continue;
            var subnets = Aws.L(f.VpcConfig!.SubnetIds);
            var sgs = Aws.L(f.VpcConfig.SecurityGroupIds);
            var n = b.Node(ctx.Id(NodeKinds.LambdaFunction, f.FunctionArn), NodeKinds.LambdaFunction, f.FunctionArn, ctx.Account, ctx.Region)
                .Named(f.FunctionName).Under(ctx.NetworkId(vpc)).SetState(f.State?.Value?.ToLowerInvariant())
                .Attr("functionName", f.FunctionName).Attr("runtime", f.Runtime?.Value).Attr("packageType", f.PackageType?.Value)
                .Attr("lastUpdateStatus", f.LastUpdateStatus?.Value).Attr("memorySize", f.MemorySize).Attr("timeout", f.Timeout)
                .Attr("architectures", NodeExtensions.Arr(Aws.L(f.Architectures)))
                .Attr("subnets", NodeExtensions.Arr(subnets)).Attr("securityGroups", NodeExtensions.Arr(sgs))
                .Attr("ipv6AllowedForDualStack", f.VpcConfig.Ipv6AllowedForDualStack == true ? true : null);

            var subnetIds = subnets.Select(s => ctx.Id(NodeKinds.Subnet, s)).ToHashSet(StringComparer.Ordinal);
            var sgIds = sgs.Select(s => ctx.Id(NodeKinds.SecurityGroup, s)).ToHashSet(StringComparer.Ordinal);
            foreach (var s in subnetIds) b.Edge(n.Id, EdgeKinds.PlacedIn, s);
            foreach (var s in sgIds) b.Edge(n.Id, EdgeKinds.Uses, s);
            foreach (var (eni, fn, subnet) in lambdaEnis)
            {
                var sameSet = subnet != null && subnetIds.Contains(subnet) && eniSgs.TryGetValue(eni.Id, out var es) && es.SetEquals(sgIds);
                if (fn == f.FunctionName || sameSet) b.Edge(n.Id, EdgeKinds.RunsOn, eni.Id).Attr("ip", eni.AttrString("privateIp"));
            }
        }
        return b.Build();
    }
}
