namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Messages for the "every scope belongs to this workspace" check (the platform ScopeHelper call lives in the service).</summary>
public static class WorkspaceScopes
{
    public const string NotVerifiable = "Unable to verify that the scope(s) belong to this workspace.";

    public static string NotInWorkspace(IEnumerable<string> ids) => $"Scope(s) not available in this workspace: {string.Join(", ", ids)}";
}
