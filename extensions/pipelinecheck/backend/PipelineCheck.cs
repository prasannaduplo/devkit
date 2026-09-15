using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.PipelineCheck;

// A first-class DuploCloud resource shipped inside a hot-loaded extension DLL. Same shape the host's
// own resources use (Namespace, NetworkBaseline): ResourceBase + ResourceServiceBase + ResourcesController.
// The loader resolves these SDK base types from the host (Default ALC), so type identity is shared.
//
// The four classes below are the whole backend. Together with PipelineCheckController they give you full
// CRUD + POST {id}/status + POST {id}/results + the provisioning lifecycle, with no boilerplate.
// Reference: reference/03-base-classes.md (every member), reference/04-hooks.md (when each hook fires),
// reference/01-architecture.md (the provisioning loop + hot-load).

/// <summary>User-supplied inputs for a Pipeline Check resource.</summary>
public class PipelineCheckSpec : BaseSpec
{
    public string? FirstName { get; set; }
    public string? LastName { get; set; }
}

/// <summary>Outputs the provisioning skill writes back.</summary>
public class PipelineCheckResult : BaseResult
{
    public string? FullName { get; set; }
}

/// <summary>
/// The entity. Its own Mongo collection (real persistence). The ticket origin type/sub-type drive
/// skill-mapping resolution during provisioning.
/// </summary>
[BsonCollection("extension_pipelinechecks")]
public class PipelineCheck : ResourceBase<PipelineCheckSpec, PipelineCheckResult>
{
    public override string GetTicketOriginType() => "PipelineCheck";
    public override string GetTicketOriginSubType() => "pipeline-check";
}

/// <summary>
/// No-op hooks (framework default base). Swap to <c>ResourceHooksBase&lt;PipelineCheck, PipelineCheckSpec,
/// PipelineCheckResult&gt;</c> if you need the standard invariants (OwnerWorkspaceId immutability, immutable
/// spec fields, delete-status gate) and override <c>GetImmutableSpecFields</c>/<c>GetDeletableStatuses</c>.
/// See reference/04-hooks.md.
/// </summary>
public class PipelineCheckHooks : DefaultEntityHooks<PipelineCheck>
{
}

/// <summary>
/// Resource service deriving from the real <see cref="ResourceServiceBase{TResource,TSpec,TResult}"/>.
/// Standard CRUD + the provisioning lifecycle (OnAfterCreate fires a ticket) come from the base; the
/// extension host's per-extension child container satisfies the ctor dependencies.
/// </summary>
public class PipelineCheckService : ResourceServiceBase<PipelineCheck, PipelineCheckSpec, PipelineCheckResult>
{
    public PipelineCheckService(
        IRepository<PipelineCheck> repository,
        ILogger<PipelineCheckService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
    }
}
