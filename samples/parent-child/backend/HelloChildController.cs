using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.DataManagement.Models;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.ParentChild;

/// <summary>
/// Child REST controller at the NESTED route <c>.../hello-parents/{parentId}/hello-children</c>. Extends
/// <see cref="ChildResourceController{TChild,TParent,TSpec,TResult}"/> and overrides <c>Create</c> to stamp
/// <c>Spec.ParentId</c> from the route + validate the parent (see reference/08-parent-child-and-menus.md).
/// Do NOT add a second [HttpPost] or call the base Create (its CreatedAtAction can't build a nested Location).
/// </summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/hello-parents/{parentId}/hello-children")]
// Access node under the PARENT resource, not the workspace — granting the parent with subtree
// cascade covers every child. ParentIdProperty must be spelled out: Spec.ParentId is not one of the
// registry's convention paths (Spec.ResourceGroupId, OwnerWorkspaceId, WorkspaceId), and omitting it
// would silently bind this node to the workspace via the OwnerWorkspaceId every entity carries.
// See reference/18-access-control.md.
[AccessControl(Parent = typeof(HelloParent), ParentIdProperty = "Spec.ParentId")]
public class HelloChildrenController : ChildResourceController<HelloChild, HelloParent, HelloChildSpec, HelloChildResult>
{
    private readonly IEntityService<HelloParent> _parent;

    public HelloChildrenController(
        IEntityService<HelloChild> service,
        IEntityService<HelloParent> parent,
        ILogger<HelloChildrenController> logger)
        : base(service, parent, logger)
    {
        _parent = parent;
    }

    [HttpPost]
    public override async Task<IActionResult> Create([FromBody] HelloChild resource, CancellationToken ct = default)
    {
        if (resource?.Spec is null)
        {
            return BadRequest(ApiResponse<object>.ErrorResult("Invalid request", "Body required."));
        }

        var parentId = RouteData.Values["parentId"]?.ToString();
        if (string.IsNullOrEmpty(parentId))
        {
            return BadRequest(ApiResponse<object>.ErrorResult("Invalid request", "parentId required."));
        }
        if (await _parent.GetByIdAsync(parentId, ct) is null)
        {
            return NotFound(ApiResponse<object>.ErrorResult("Not found", $"Parent '{parentId}' not found."));
        }

        resource.Spec.ParentId = parentId;
        resource.OwnerWorkspaceId = GetWorkspaceIdFromRoute();

        try
        {
            var created = await Service.CreateAsync(resource, ct);   // validates, fires provisioning
            return StatusCode(StatusCodes.Status201Created, ApiResponse<HelloChild>.SuccessResult(created, "Created"));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.ErrorResult("Invalid request", ex.Message));
        }
    }
}
