using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.AppStack;

/// <summary>Workspace-scoped REST controller for the worker-backed AppStack demo.</summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/appstacks")]
// Access node under the workspace — see reference/18-access-control.md.
[AccessControl(Parent = typeof(Workspace), ParentIdProperty = "OwnerWorkspaceId")]
public class AppStacksController : ResourcesController<AppStack, AppStackSpec, AppStackResult>
{
    public AppStacksController(IEntityService<AppStack> service, ILogger<AppStacksController> logger)
        : base(service, logger)
    {
    }
}
