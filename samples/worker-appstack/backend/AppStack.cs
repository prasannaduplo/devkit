using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.AppStack;

// WORKER sample — a multi-object resource (Deployment + Service) reconciled by a BACKGROUND WORKER instead
// of the agent or a synchronous passthrough. With no skill mapping, the service returns Worker from
// NoSkillsFallbackMode; the AppStackWorker (a ResourceWorkerBase) applies/deletes on its tick. See
// reference/04-hooks (worker seams) + reference/11-deprovisioning (worker deprovision path).

[BsonIgnoreExtraElements]
public class AppStackSpec : BaseSpec
{
    public string? Namespace { get; set; }
    public string? Image { get; set; }
    public int Replicas { get; set; } = 1;
}

[BsonIgnoreExtraElements]
public class AppStackResult : BaseResult
{
    public string? DeploymentName { get; set; }
    public string? ServiceName { get; set; }
}

[BsonCollection("extension_appstacks")]
[BsonIgnoreExtraElements]
public class AppStack : ResourceBase<AppStackSpec, AppStackResult>
{
    public override string GetTicketOriginType() => "AppStack";
    public override string GetTicketOriginSubType() => "app-stack";
}

public class AppStackHooks : DefaultEntityHooks<AppStack>
{
}

/// <summary>
/// Service with no skill mapping; returning <see cref="ProvisioningMode.Worker"/> routes create/update/delete
/// through the background <see cref="AppStackWorker"/> (multi-object, retry/reconcile) instead of synchronous
/// passthrough. The worker holds the apply/delete logic.
/// </summary>
public class AppStackService : ResourceServiceBase<AppStack, AppStackSpec, AppStackResult>
{
    public AppStackService(
        IRepository<AppStack> repository,
        ILogger<AppStackService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
    }

    protected override ProvisioningMode NoSkillsFallbackMode => ProvisioningMode.Worker;
}
