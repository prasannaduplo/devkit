using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.DataManagement.Models;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.NetMap;

// ── Response shapes for the VPC drill-down — computed live, never persisted (see reference/05-custom-actions.md
// pattern #6: "an extra controller API your remote consumes"). Resources are grouped under the security
// group(s) they're attached to (SecurityGroupCard), not listed flat per subnet, and connections aggregate
// to card-to-card edges with a rule breakdown instead of one edge per resource pair. ──
public record ResourceNode(
    string Id, string Name, string Kind,
    bool InboundOpen, bool OutboundOpen, List<string> OpenDetails,
    List<string> Urls);

/// <summary>All resources in one subnet that share one security group. Id is "{subnetId}::{sgId}" -- the
/// composite key connections are drawn between.</summary>
public record SecurityGroupCard(
    string Id, string SecurityGroupId, string Name,
    bool InboundOpen, bool OutboundOpen, List<ResourceNode> Resources);

public record SubnetLane(
    string SubnetId, string Cidr, string AvailabilityZone, bool IsPublic, List<SecurityGroupCard> SecurityGroups,
    List<string> ExternalRouteTargets);

/// <summary>One bucketed rule behind an edge -- Label is either a protocol/port (card-to-card, e.g.
/// "tcp/443") or a full open-rule description (internet edges, e.g. "outbound all ports to 0.0.0.0/0").
/// Count is the number of underlying resource-to-resource connections the rule accounts for.</summary>
public record ConnectionRule(string Label, int Count);

public record ConnectionEdge(string FromId, string ToId, int Count, bool ToInternet, bool FromInternet, List<ConnectionRule> Rules);

public record VpcDetail(string VpcId, string Cidr, List<SubnetLane> Subnets, List<ConnectionEdge> Connections);

[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/networkmaps")]
public class NetworkMapController : ResourcesController<NetworkMap, NetworkMapSpec, NetworkMapResult>
{
    // IScopeClientFactory cannot be resolved into a controller's constructor in this host (confirmed --
    // activation fails with "Unable to resolve service for type IScopeClientFactory" even for the base
    // CRUD routes). Every other extension in this repo that talks to a cloud API does so from the
    // SERVICE layer, where DI resolves it fine -- so the actual AWS scan lives on NetworkMapService, and
    // this controller just calls it. Inject the concrete service type alongside the base's
    // IEntityService<NetworkMap> (both resolve to the same per-extension-registered instance).
    private readonly NetworkMapService _netMapService;

    public NetworkMapController(IEntityService<NetworkMap> service, ILogger<NetworkMapController> logger, NetworkMapService netMapService)
        : base(service, logger)
    {
        _netMapService = netMapService;
    }

    [HttpGet("{id}/vpcs/{vpcId}/detail")]
    public async Task<IActionResult> GetVpcDetail(string workspaceId, string id, string vpcId, CancellationToken ct)
    {
        var entity = await Service.GetByIdAsync(id, ct);
        if (entity is null || entity.OwnerWorkspaceId != GetWorkspaceIdFromRoute())
            return NotFound(ApiResponse<object>.ErrorResult("Not found", $"NetworkMap '{id}' not found."));

        var spec = entity.Spec;
        if (spec?.Region == null || spec.ScopeIds == null || spec.ScopeIds.Count == 0)
            return BadRequest(ApiResponse<object>.ErrorResult("Invalid request", "No AWS scope/region on this resource."));

        try
        {
            var result = await _netMapService.GetVpcDetailAsync(entity, vpcId, ct);
            if (result is null)
                return NotFound(ApiResponse<object>.ErrorResult("Not found", $"VPC '{vpcId}' not found in {spec.Region}."));
            return Ok(ApiResponse<VpcDetail>.SuccessResult(result));
        }
        catch (Exception ex)
        {
            return StatusCode(502, ApiResponse<object>.ErrorResult("AWS error", ex.Message));
        }
    }
}
