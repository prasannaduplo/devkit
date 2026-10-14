using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.Calculator;

/// <summary>Workspace-scoped REST controller for the worker-backed Calculator.</summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/calcworkers")]
// Access node under the workspace — see reference/18-access-control.md.
[AccessControl(Parent = typeof(Workspace), ParentIdProperty = "OwnerWorkspaceId")]
public class CalculatorController : ResourcesController<Calculator, CalculatorSpec, CalculatorResult>
{
    public CalculatorController(IEntityService<Calculator> service, ILogger<CalculatorController> logger)
        : base(service, logger)
    {
    }
}
