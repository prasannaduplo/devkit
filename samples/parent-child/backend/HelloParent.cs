using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.ParentChild;

// PARENT resource of the parent/child sample. Same shape as the hello-world single resource — a
// first-class typed resource (ResourceBase + ResourceServiceBase + ResourcesController). The CHILD
// (HelloChild) links to it via a nested route + ParentRefSpec. See reference/08-parent-child-and-menus.md.

/// <summary>User-supplied inputs for a parent.</summary>
[BsonIgnoreExtraElements]
public class HelloParentSpec : BaseSpec
{
    public string? Title { get; set; }
}

/// <summary>Outputs the provisioning skill writes back.</summary>
[BsonIgnoreExtraElements]
public class HelloParentResult : BaseResult
{
    public string? Slug { get; set; }
}

[BsonCollection("extension_hello_parents")]
[BsonIgnoreExtraElements]
public class HelloParent : ResourceBase<HelloParentSpec, HelloParentResult>
{
    public override string GetTicketOriginType() => "HelloParent";
    public override string GetTicketOriginSubType() => "hello-parent";
}

/// <summary>
/// Parent hooks: CASCADE the children (reference/08 — "when the parent is deleted or de-provisioned,
/// delete its children in the parent's entity hook"). Hooks are constructed from the extension's DI
/// container, so dependencies inject like anywhere else; the child service is resolved LAZILY through a
/// scope (the platform hook pattern — see ResourceHooksBase's (ILogger, IServiceProvider) ctor) to avoid
/// any parent/child registration-order coupling.
/// </summary>
public class HelloParentHooks : DefaultEntityHooks<HelloParent>
{
    private readonly ILogger<HelloParentHooks> _logger;
    private readonly IServiceScopeFactory _scopeFactory;

    public HelloParentHooks(ILogger<HelloParentHooks> logger, IServiceScopeFactory scopeFactory)
    {
        _logger = logger;
        _scopeFactory = scopeFactory;
    }

    /// <summary>Hard delete of the parent row → delete every child row it owns.</summary>
    public override async Task OnPostDeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        await base.OnPostDeleteAsync(id, cancellationToken);
        await CascadeDeleteChildrenAsync(id, cancellationToken);
    }

    /// <summary>Deprovision path: the row flips to DeProvisioned before (auto-)deletion — cascade then too.</summary>
    public override async Task OnPostUpdateAsync(HelloParent entity, CancellationToken cancellationToken = default)
    {
        await base.OnPostUpdateAsync(entity, cancellationToken);
        if (entity.Status == ResourceStatus.DeProvisioned && entity.Id is not null)
        {
            await CascadeDeleteChildrenAsync(entity.Id, cancellationToken);
        }
    }

    private async Task CascadeDeleteChildrenAsync(string parentId, CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var children = scope.ServiceProvider.GetRequiredService<IEntityService<HelloChild>>();
        var orphans = await children.FindAsync(c => c.Spec != null && c.Spec.ParentId == parentId, ct);
        foreach (var child in orphans)
        {
            if (child.Id is null)
            {
                continue;
            }
            await children.DeleteAsync(child.Id, ct);
            _logger.LogInformation("Cascaded delete of child {ChildId} ({ChildName}) of parent {ParentId}",
                child.Id, child.Name, parentId);
        }
    }
}

public class HelloParentService : ResourceServiceBase<HelloParent, HelloParentSpec, HelloParentResult>
{
    public HelloParentService(
        IRepository<HelloParent> repository,
        ILogger<HelloParentService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
    }
}
