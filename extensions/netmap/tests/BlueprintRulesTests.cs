using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class BlueprintRulesTests
{
    private static BlueprintMember M(string scope, string region, string vpc, string provider = "aws") =>
        new() { ScopeId = scope, Region = region, NetworkId = vpc, Provider = provider };

    [Fact]
    public void Requires_at_least_one_member()
    {
        var act = () => BlueprintRules.Validate(new List<BlueprintMember>());
        act.Should().Throw<ArgumentException>().WithMessage("*at least one network*");
    }

    [Fact]
    public void Rejects_duplicates_unknown_providers_and_non_vpc_ids()
    {
        FluentActions.Invoking(() => BlueprintRules.Validate(new List<BlueprintMember> { M("s", "us-east-1", "vpc-1"), M("s", "us-east-1", "vpc-1") }))
            .Should().Throw<ArgumentException>().WithMessage("*listed twice*");
        FluentActions.Invoking(() => BlueprintRules.Validate(new List<BlueprintMember> { M("s", "eastus", "vnet-1", "azure") }))
            .Should().Throw<ArgumentException>().WithMessage("*not supported yet*");
        FluentActions.Invoking(() => BlueprintRules.Validate(new List<BlueprintMember> { M("s", "us-east-1", "subnet-1") }))
            .Should().Throw<ArgumentException>().WithMessage("*not a VPC id*");
        FluentActions.Invoking(() => BlueprintRules.Validate(new List<BlueprintMember> { M("", "us-east-1", "vpc-1") }))
            .Should().Throw<ArgumentException>().WithMessage("*scope, region and network id*");
    }

    [Fact]
    public void Rejects_the_same_network_listed_under_different_scopes()
    {
        FluentActions.Invoking(() => BlueprintRules.Validate(new List<BlueprintMember> { M("s1", "us-east-1", "vpc-1"), M("s2", "us-east-1", "vpc-1") }))
            .Should().Throw<ArgumentException>().WithMessage("vpc-1 in us-east-1 is listed twice.");
        FluentActions.Invoking(() => BlueprintRules.Validate(new List<BlueprintMember> { M("s1", "us-east-1", "vpc-1"), M("s2", "us-west-2", "vpc-1") }))
            .Should().NotThrow();
    }

    [Fact]
    public void Normalize_trims_and_defaults_provider()
    {
        var members = new List<BlueprintMember> { new() { ScopeId = " s ", Region = " us-east-1 ", NetworkId = " vpc-1 ", Provider = "" } };
        BlueprintRules.Normalize(members);
        members[0].Should().BeEquivalentTo(new { ScopeId = "s", Region = "us-east-1", NetworkId = "vpc-1", Provider = "aws" });
    }

    [Fact]
    public void Derived_scope_ids_and_members_hash_are_order_independent()
    {
        var a = new List<BlueprintMember> { M("s2", "us-east-1", "vpc-2"), M("s1", "us-east-1", "vpc-1"), M("s1", "us-west-2", "vpc-3") };
        var b = new List<BlueprintMember> { a[2], a[0], a[1] };

        BlueprintRules.DerivedScopeIds(a).Should().Equal("s1", "s2");
        BlueprintRules.MembersHash(a).Should().Be(BlueprintRules.MembersHash(b));
        BlueprintRules.MembersHash(a).Should().NotBe(BlueprintRules.MembersHash(a.Take(2)));
    }
}
