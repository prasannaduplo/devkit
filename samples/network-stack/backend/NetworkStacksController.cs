using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.NetworkStack;

/// <summary>
/// Workspace-scoped REST controller. The base gives full CRUD + <c>POST {id}/results</c> +
/// <c>POST {id}/status</c> at <c>…/environment/extensions/network-stacks</c>; this adds the
/// action-driven surface (plan/apply) and the run-history/log reads behind the Logs tab.
/// Plan and Apply are separate routes (not one body-dispatched endpoint) precisely so each can carry its
/// own named access action below — the access filter runs before model binding and cannot read the body,
/// so a single body-dispatched endpoint could only ever be gated as one undifferentiated permission.
/// </summary>
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/network-stacks")]
// Access node under the workspace. This governs the inherited CRUD surface by verb; the two mutating
// actions below opt out of verb checks in favour of named actions. See reference/18-access-control.md.
[AccessControl(Parent = typeof(Workspace), ParentIdProperty = "OwnerWorkspaceId")]
public class NetworkStacksController : ResourcesController<NetworkStack, NetworkStackSpec, NetworkStackResult>
{
    private readonly NetworkStackService _svc;

    public NetworkStacksController(
        IEntityService<NetworkStack> service, NetworkStackService svc,
        ILogger<NetworkStacksController> logger)
        : base(service, logger)
    {
        _svc = svc;
    }

    /// <summary>Preview: run a terraform plan. Mutates nothing; the agent runs it async on the resource's
    /// long-lived ticket. 202.</summary>
    [HttpPost("{id}/plan")]
    // A named action, not the POST verb: previewing changes is a capability an admin grants
    // deliberately, and "can edit this resource" must not imply it. ALL verbs never grants an action.
    [AccessControl(Action = "network-stack.plan",
        ActionName = "Preview network changes",
        Description = "Runs a terraform plan and shows what would change. Mutates no infrastructure.")]
    public Task<ActionResult> Plan(string workspaceId, string id, CancellationToken ct = default)
        => RunAction(workspaceId, id, "plan", ct);

    /// <summary>Apply the previewed changes — creates/reconfigures live AWS networking. Refused until a
    /// plan has succeeded (see NetworkStackResult.ApplyAllowed). 202.</summary>
    [HttpPost("{id}/apply")]
    // Destructive = true surfaces a warning affordance in the permission editor. Granting plan does not
    // grant apply — they are separate action ids precisely so a reviewer can hold one without the other.
    [AccessControl(Action = "network-stack.apply", Destructive = true,
        ActionName = "Apply network changes",
        Description = "Creates and reconfigures live AWS networking from the last successful plan.")]
    public Task<ActionResult> Apply(string workspaceId, string id, CancellationToken ct = default)
        => RunAction(workspaceId, id, "apply", ct);

    private async Task<ActionResult> RunAction(string workspaceId, string id, string action, CancellationToken ct)
    {
        try
        {
            await _svc.TriggerActionAsync(workspaceId, id, action, ct);
            return Accepted();
        }
        catch (ArgumentException ex) { return BadRequest(ex.Message); }
        catch (KeyNotFoundException ex) { return NotFound(ex.Message); }
        catch (InvalidOperationException ex) { return BadRequest(ex.Message); }
    }

    // ── Run history + logs (Logs tab) — read from the ticket workdir, see reference/05 §7 ────────────
    // No [AccessControl] on these: they are plain reads, so the inherited GET verb check is exactly
    // right. Declare a named action only where a verb grant should NOT imply the capability.

    [HttpGet("{id}/plan-history")]
    public async Task<ActionResult<IReadOnlyList<NetworkStackRunMeta>>> GetPlanHistory(string workspaceId, string id, CancellationToken ct = default)
        => Ok(await _svc.GetPlanHistoryAsync(workspaceId, id, ct));

    [HttpGet("{id}/apply-history")]
    public async Task<ActionResult<IReadOnlyList<NetworkStackRunMeta>>> GetApplyHistory(string workspaceId, string id, CancellationToken ct = default)
        => Ok(await _svc.GetApplyHistoryAsync(workspaceId, id, ct));

    [HttpGet("{id}/plans/{runId}")]
    public async Task<ActionResult<NetworkStackRunDetail>> GetPlan(string workspaceId, string id, string runId, CancellationToken ct = default)
    {
        var d = await _svc.GetPlanAsync(workspaceId, id, runId, ct);
        return d is null ? NotFound() : Ok(d);
    }

    [HttpGet("{id}/applies/{runId}")]
    public async Task<ActionResult<NetworkStackRunDetail>> GetApply(string workspaceId, string id, string runId, CancellationToken ct = default)
    {
        var d = await _svc.GetApplyAsync(workspaceId, id, runId, ct);
        return d is null ? NotFound() : Ok(d);
    }
}
