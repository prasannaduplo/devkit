using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Per blueprint member: ok (collected, with refreshed name + CIDRs), scope-error (its core unit failed
/// or was denied -- usually bad credentials), or missing (scanned fine, VPC not there any more).</summary>
public static class MemberStatusEvaluator
{
    public static List<MemberStatus> Evaluate(GraphIndex g, IReadOnlyList<BlueprintMember> members, IReadOnlyList<WorkUnit> units) =>
        members.Select(m =>
        {
            var s = new MemberStatus { ScopeId = m.ScopeId, Region = m.Region, NetworkId = m.NetworkId };
            var node = g.Node(AwsIds.Of(m.Region, NodeKinds.Network, m.NetworkId));
            if (node is { Visibility: Visibilities.Full })
            {
                s.Status = MemberStates.Ok;
                s.DisplayName = node.Name;
                s.Cidrs = node.Cidrs.ToList();
                return s;
            }
            var core = units.FirstOrDefault(u => u.Collector == Collectors.CoreNetwork.Id && u.ScopeId == m.ScopeId && u.Region == m.Region);
            if (core is { Status: UnitStatuses.Failed or UnitStatuses.Denied })
            {
                s.Status = MemberStates.ScopeError;
                s.Message = core.Error ?? (core.MissingPermission is { } p ? $"denied — missing {p}" : "denied");
                return s;
            }
            s.Status = MemberStates.Missing;
            s.Message = $"{m.NetworkId} not found in {m.Region}";
            return s;
        }).ToList();
}
