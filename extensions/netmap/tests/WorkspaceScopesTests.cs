using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class WorkspaceScopesTests
{
    [Fact]
    public void Messages_are_stable()
    {
        WorkspaceScopes.NotVerifiable.Should().Be("Unable to verify that the scope(s) belong to this workspace.");
        WorkspaceScopes.NotInWorkspace(new[] { "s2", "s3" }).Should().Be("Scope(s) not available in this workspace: s2, s3");
    }
}
