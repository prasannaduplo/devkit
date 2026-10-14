using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.ParentChild;

/// <summary>
/// Parent REST controller — the standard <see cref="ResourcesController{T,TSpec,TResult}"/> surface at
/// <c>.../environment/extensions/hello-parents</c>. The child controller hangs off this route segment.
/// </summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/hello-parents")]
// Access node under the workspace — see reference/18-access-control.md.
[AccessControl(Parent = typeof(Workspace), ParentIdProperty = "OwnerWorkspaceId")]
public class HelloParentsController : ResourcesController<HelloParent, HelloParentSpec, HelloParentResult>
{
    public HelloParentsController(IEntityService<HelloParent> service, ILogger<HelloParentsController> logger)
        : base(service, logger)
    {
    }
}
