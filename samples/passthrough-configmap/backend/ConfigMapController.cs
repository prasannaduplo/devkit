using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.ConfigMapDemo;

/// <summary>Workspace-scoped REST controller for the passthrough ConfigMap demo.</summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/configmapdemos")]
// Access node under the workspace — see reference/18-access-control.md.
[AccessControl(Parent = typeof(Workspace), ParentIdProperty = "OwnerWorkspaceId")]
public class ConfigMapDemosController : ResourcesController<ConfigMapDemo, ConfigMapSpec, ConfigMapResult>
{
    public ConfigMapDemosController(IEntityService<ConfigMapDemo> service, ILogger<ConfigMapDemosController> logger)
        : base(service, logger)
    {
    }
}
