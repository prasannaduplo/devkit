using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws;

/// <param name="Account">Best-known account id for the scope (from the scope, else from collected VPC owners).</param>
/// <param name="Region">The unit's region, or "global".</param>
/// <param name="MemberVpcIds">Blueprint VPCs in this scope + region (all regions of the scope for global units).</param>
/// <param name="ScopeMembers">The same members with their regions (global units need them).</param>
/// <param name="Priors">Finished parts of earlier units of the same scope (+ region) -- see ScanEngine.PriorsFor.</param>
public sealed record CollectorContext(
    string ScopeId, string Account, string Region, IReadOnlyList<string> MemberVpcIds,
    IReadOnlyList<BlueprintMember> ScopeMembers, IReadOnlyList<GraphPart> Priors, DateTime Now)
{
    public PartBuilder Builder(string collector) => new(collector, ScopeId, Now);

    public string Id(string kind, string nativeId, string? region = null) => AwsIds.Of(region ?? Region, kind, nativeId);

    public string NetworkId(string vpcId, string? region = null) => Id(NodeKinds.Network, vpcId, region);

    public string AccountId(string? account) => NodeId.Account("aws", account ?? Account);

    public IEnumerable<GraphNode> PriorNodes(string kind) => Priors.SelectMany(p => p.Nodes).Where(n => n.Kind == kind);
}
