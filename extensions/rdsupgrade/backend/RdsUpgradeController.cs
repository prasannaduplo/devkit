using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.RdsUpgrade;

/// <summary>Workspace-scoped REST controller for the worker-backed RdsUpgrade resource.</summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/rdsupgrades")]
public class RdsUpgradeController : ResourcesController<RdsUpgrade, RdsUpgradeSpec, RdsUpgradeResult>
{
    public RdsUpgradeController(IEntityService<RdsUpgrade> service, ILogger<RdsUpgradeController> logger)
        : base(service, logger)
    {
    }
}
