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

// CHILD resource. Its spec extends ParentRefSpec<HelloParent> (adds `ParentId`, stamped by the controller
// from the nested route). Both resources register into the SAME per-extension DI container, so the child
// service can inject IEntityService<HelloParent> to read its parent. See reference/08-parent-child-and-menus.md.

/// <summary>User-supplied inputs for a child. <c>ParentId</c> comes from the base (route-stamped).</summary>
[BsonIgnoreExtraElements]
public class HelloChildSpec : ParentRefSpec<HelloParent>
{
    public string? Note { get; set; }
}

/// <summary>Outputs the provisioning skill writes back.</summary>
[BsonIgnoreExtraElements]
public class HelloChildResult : BaseResult
{
    public string? Message { get; set; }
}

[BsonCollection("extension_hello_children")]
[BsonIgnoreExtraElements]
public class HelloChild : ResourceBase<HelloChildSpec, HelloChildResult>
{
    public override string GetTicketOriginType() => "HelloChild";
    public override string GetTicketOriginSubType() => "hello-child";
}

public class HelloChildHooks : DefaultEntityHooks<HelloChild>
{
}

public class HelloChildService : ResourceServiceBase<HelloChild, HelloChildSpec, HelloChildResult>
{
    public HelloChildService(
        IRepository<HelloChild> repository,
        ILogger<HelloChildService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
    }
}
