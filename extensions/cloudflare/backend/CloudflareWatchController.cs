using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.Cloudflare;

/// <summary>
/// Workspace-scoped CRUD for <see cref="CloudflareWatch"/> at <c>.../environment/extensions/cloudflare-watches</c>.
/// Everything (CRUD, status/results, deprovision) comes from <see cref="ResourcesController{T,TSpec,TResult}"/>.
/// </summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/cloudflare-watches")]
// No [AccessControl] yet: helpdesk-dev01 runs SDK 1.0.6, which predates it (reference/18-access-control.md).
// Add it back once the target host is on an SDK that ships Duplo.Ai.DataManagement.AccessControl.
public class CloudflareWatchesController : ResourcesController<CloudflareWatch, CloudflareWatchSpec, CloudflareWatchResult>
{
    public CloudflareWatchesController(IEntityService<CloudflareWatch> service, ILogger<CloudflareWatchesController> logger)
        : base(service, logger)
    {
    }
}
