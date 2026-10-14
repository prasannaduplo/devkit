using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.Calculator;

// WORKER sample, pure-compute flavour — a resource whose "provisioning" is an in-process computation, not a
// cloud object. With no skill mapping the service returns Worker from NoSkillsFallbackMode; the background
// CalculatorWorker computes sum + product into the Result. There is no cluster/cloud involved, so the worker
// needs no scope and its delete/drift seams are no-ops. See reference/04-hooks.md (worker seams +
// SaveProgressAsync) and reference/11-deprovisioning.md.

[BsonIgnoreExtraElements]
public class CalculatorSpec : BaseSpec
{
    /// <summary>First operand.</summary>
    public double A { get; set; }

    /// <summary>Second operand.</summary>
    public double B { get; set; }
}

[BsonIgnoreExtraElements]
public class CalculatorResult : BaseResult
{
    /// <summary>A + B.</summary>
    public double Sum { get; set; }

    /// <summary>A * B.</summary>
    public double Product { get; set; }
}

[BsonCollection("extension_calcworkers")]
[BsonIgnoreExtraElements]
public class Calculator : ResourceBase<CalculatorSpec, CalculatorResult>
{
    public override string GetTicketOriginType() => "CalcWorker";
    public override string GetTicketOriginSubType() => "calc-worker";
}

public class CalculatorHooks : DefaultEntityHooks<Calculator>
{
}

/// <summary>
/// No skill mapping → returning <see cref="ProvisioningMode.Worker"/> routes create/update through the
/// background <see cref="CalculatorWorker"/>. The worker holds the compute logic.
/// </summary>
public class CalculatorService : ResourceServiceBase<Calculator, CalculatorSpec, CalculatorResult>
{
    public CalculatorService(
        IRepository<Calculator> repository,
        ILogger<CalculatorService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
    }

    protected override ProvisioningMode NoSkillsFallbackMode => ProvisioningMode.Worker;
}
