using System.Text.Json.Nodes;
using Amazon.Runtime;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.DataManagement.Models;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.NetMap;

// Standard CRUD comes from ResourcesController. The extra actions delegate to NetworkBlueprintService because
// IScopeClientFactory / IScopeCredentials only resolve at the service layer in this host (see NetworkMapController).
// [AccessControl] is omitted: hosts on SDK 1.0.6 predate it.
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/networkblueprints")]
public class NetworkBlueprintController : ResourcesController<NetworkBlueprint, NetworkBlueprintSpec, NetworkBlueprintResult>
{
    private readonly NetworkBlueprintService _blueprints;

    public NetworkBlueprintController(IEntityService<NetworkBlueprint> service, ILogger<NetworkBlueprintController> logger, NetworkBlueprintService blueprints)
        : base(service, logger)
    {
        _blueprints = blueprints;
    }

    [HttpGet("picker/regions")]
    public Task<IActionResult> PickerRegions(string workspaceId, [FromQuery] string scopeId, CancellationToken ct) =>
        Guard(async () => Ok(ApiResponse<List<string>>.SuccessResult(await _blueprints.ListRegionsAsync(scopeId, ct))));

    [HttpGet("picker/vpcs")]
    public Task<IActionResult> PickerVpcs(string workspaceId, [FromQuery] string scopeId, [FromQuery] string region, CancellationToken ct) =>
        Guard(async () => Ok(ApiResponse<List<PickerVpc>>.SuccessResult(await _blueprints.ListVpcsAsync(scopeId, region, ct))));

    [HttpGet("{id}/snapshots")]
    public Task<IActionResult> Snapshots(string workspaceId, string id, CancellationToken ct) => Guard(async () =>
    {
        var bp = await LoadAsync(id, ct);
        return bp is null ? NotFoundResult(id) : Ok(ApiResponse<List<SnapshotHeader>>.SuccessResult(await _blueprints.ListSnapshotsAsync(bp, ct)));
    });

    [HttpGet("{id}/snapshots/{snapshotId}/graph")]
    public Task<IActionResult> Graph(string workspaceId, string id, string snapshotId, CancellationToken ct) => Guard(async () =>
    {
        var bp = await LoadAsync(id, ct);
        if (bp is null) return NotFoundResult(id);
        var json = await _blueprints.GetGraphJsonAsync(bp, snapshotId, ct);
        return json is null
            ? NotFound(ApiResponse<object>.ErrorResult("Not found", $"No graph for snapshot '{snapshotId}'."))
            : Ok(ApiResponse<JsonNode>.SuccessResult(JsonNode.Parse(json)!));
    });

    private async Task<NetworkBlueprint?> LoadAsync(string id, CancellationToken ct)
    {
        var e = await Service.GetByIdAsync(id, ct);
        return e is null || e.OwnerWorkspaceId != GetWorkspaceIdFromRoute() ? null : e;
    }

    private IActionResult NotFoundResult(string id) =>
        NotFound(ApiResponse<object>.ErrorResult("Not found", $"Network blueprint '{id}' not found."));

    private async Task<IActionResult> Guard(Func<Task<IActionResult>> body)
    {
        try { return await body(); }
        catch (ArgumentException ex) { return BadRequest(ApiResponse<object>.ErrorResult("Invalid request", ex.Message)); }
        catch (InvalidOperationException ex) { return BadRequest(ApiResponse<object>.ErrorResult("Invalid request", ex.Message)); }
        catch (AmazonClientException ex) { return StatusCode(502, ApiResponse<object>.ErrorResult("AWS error", ex.Message)); }   // also covers AmazonServiceException
    }
}
