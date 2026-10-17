using System.Text.Json.Nodes;
using Amazon.Runtime;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.DataManagement.Models;
using Duplo.Ai.Model.Interfaces;
using Duplo.Extension.NetMap.Core.Graph;
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

    /// <summary>The snapshot graph. <c>raw=</c> none | routing (raw kept only for network ACLs and security groups,
    /// which the path engine reads) | all (default). <c>encoding=</c> json (default) | gzip64, which returns
    /// <c>{ encoding: "gzip-base64", data }</c> because the platform proxy does not compress responses.</summary>
    [HttpGet("{id}/snapshots/{snapshotId}/graph")]
    public Task<IActionResult> Graph(string workspaceId, string id, string snapshotId,
        [FromQuery] string? raw, [FromQuery] string? encoding, CancellationToken ct) => Guard(async () =>
    {
        var rawMode = GraphTransfer.ParseRawMode(raw);
        var enc = GraphTransfer.ParseEncoding(encoding);
        var bp = await LoadAsync(id, ct);
        if (bp is null) return NotFoundResult(id);
        var graph = await _blueprints.GetGraphAsync(bp, snapshotId, ct);
        return graph is null
            ? NoGraph(snapshotId)
            : Ok(ApiResponse<JsonNode>.SuccessResult(GraphTransfer.Body(graph, rawMode, enc)));
    });

    /// <summary>One node's sanitized raw JSON as <c>{ nodeId, raw }</c>; the side panel loads it on demand.</summary>
    [HttpGet("{id}/snapshots/{snapshotId}/nodes/raw")]
    public Task<IActionResult> NodeRaw(string workspaceId, string id, string snapshotId, [FromQuery] string? nodeId, CancellationToken ct) => Guard(async () =>
    {
        if (string.IsNullOrEmpty(nodeId)) throw new ArgumentException("nodeId is required.");
        var bp = await LoadAsync(id, ct);
        if (bp is null) return NotFoundResult(id);
        var graph = await _blueprints.GetGraphAsync(bp, snapshotId, ct);
        if (graph is null) return NoGraph(snapshotId);
        var body = GraphTransfer.NodeRaw(graph, nodeId);
        return body is null
            ? NotFound(ApiResponse<object>.ErrorResult("Not found", $"No node '{nodeId}' in snapshot '{snapshotId}'."))
            : Ok(ApiResponse<JsonNode>.SuccessResult(body));
    });

    private IActionResult NoGraph(string snapshotId) =>
        NotFound(ApiResponse<object>.ErrorResult("Not found", $"No graph for snapshot '{snapshotId}'."));

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
