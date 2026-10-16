using Duplo.Extension.NetMap.Core.Aws.Fetch;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class CollectorCatalogTests
{
    [Fact]
    public void Every_descriptor_has_exactly_one_collector()
    {
        CollectorCatalog.All.Select(c => c.Descriptor.Id).Should().BeEquivalentTo(Collectors.All.Select(d => d.Id));
        CollectorCatalog.All.Select(c => c.Descriptor.Id).Should().OnlyHaveUniqueItems();
        CollectorCatalog.Get(Collectors.Vpn.Id).Descriptor.Should().Be(Collectors.Vpn);
        FluentActions.Invoking(() => CollectorCatalog.Get("aws.nope")).Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void Chunks_respects_the_ec2_filter_limit()
    {
        Fetch.Chunks(Enumerable.Range(0, 450).Select(i => $"eni-{i}")).Select(c => c.Count).Should().Equal(200, 200, 50);
        Fetch.Chunks(Array.Empty<string>()).Should().BeEmpty();
    }
}
