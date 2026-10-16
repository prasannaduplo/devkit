using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class ScanPlannerTests
{
    [Fact]
    public void One_unit_per_collector_per_scope_region_group_plus_global_units_per_scope_last()
    {
        var members = new List<BlueprintMember>
        {
            new() { ScopeId = "net", Region = "us-east-1", NetworkId = "vpc-1" },
            new() { ScopeId = "net", Region = "us-east-1", NetworkId = "vpc-2" },
            new() { ScopeId = "prod", Region = "us-west-2", NetworkId = "vpc-3" },
        };

        var units = ScanPlanner.Plan(members, Collectors.All);

        var regional = Collectors.All.Count(c => !c.Global);
        var global = Collectors.All.Count(c => c.Global);
        units.Should().HaveCount(2 * regional + 2 * global);
        units.Select(u => u.Id).Should().OnlyHaveUniqueItems();
        units.First().Id.Should().Be("aws.core-network|net|us-east-1");
        units.TakeLast(2).Should().OnlyContain(u => u.Region == "global" && u.Collector == Collectors.DnsZones.Id);
        units.Should().OnlyContain(u => u.Status == UnitStatuses.Pending);

        var netUnits = units.Where(u => u.ScopeId == "net" && u.Region == "us-east-1").Select(u => u.Order).ToList();
        netUnits.Should().BeInAscendingOrder();
    }
}
