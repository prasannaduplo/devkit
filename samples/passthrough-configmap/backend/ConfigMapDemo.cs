using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using k8s;
using k8s.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.ConfigMapDemo;

// PASSTHROUGH sample — a single Kubernetes object created/updated/deleted SYNCHRONOUSLY on CRUD, no agent
// and no worker. With no skill mapping, the base sets ProvisionedMode=Passthrough and calls the *Direct*
// seams. The k8s client comes from the SDK's IScopeClientFactory. See reference/04-hooks + 11-deprovisioning.

[BsonIgnoreExtraElements]
public class ConfigMapSpec : BaseSpec
{
    public string? Namespace { get; set; }
    public Dictionary<string, string>? Data { get; set; }
}

[BsonIgnoreExtraElements]
public class ConfigMapResult : BaseResult
{
    public string? Uid { get; set; }
}

[BsonCollection("extension_configmapdemos")]
[BsonIgnoreExtraElements]
public class ConfigMapDemo : ResourceBase<ConfigMapSpec, ConfigMapResult>
{
    public override string GetTicketOriginType() => "ConfigMapDemo";
    public override string GetTicketOriginSubType() => "configmap-demo";
}

public class ConfigMapHooks : DefaultEntityHooks<ConfigMapDemo>
{
}

public class ConfigMapService : ResourceServiceBase<ConfigMapDemo, ConfigMapSpec, ConfigMapResult>
{
    private readonly IScopeClientFactory _clients;

    public ConfigMapService(
        IRepository<ConfigMapDemo> repository,
        ILogger<ConfigMapService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor,
        IScopeClientFactory clients)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
        _clients = clients;
    }

    // Row is removed when the object is deleted (passthrough default; shown explicitly).
    protected override bool AutoDeleteOnDeProvision(ConfigMapDemo? entity = null) => true;

    // create
    protected override async Task ProvisionDirectAsync(ConfigMapDemo e, CancellationToken ct)
    {
        // The SDK builds a fresh client per call — dispose it when done (SDK contract).
        using var client = await ClientAsync(e, ct);
        var ns = Ns(e);
        var body = new V1ConfigMap
        {
            Metadata = new V1ObjectMeta { Name = e.Name, NamespaceProperty = ns },
            Data = e.Spec?.Data,
        };
        var applied = await client.CoreV1.CreateNamespacedConfigMapAsync(body, ns, cancellationToken: ct);
        e.Result ??= new ConfigMapResult();
        e.Result.Uid = applied.Metadata?.Uid;
    }

    // update (re-apply)
    protected override async Task UpdateDirectAsync(ConfigMapDemo e, CancellationToken ct)
    {
        using var client = await ClientAsync(e, ct);
        var ns = Ns(e);
        var body = new V1ConfigMap
        {
            Metadata = new V1ObjectMeta { Name = e.Name, NamespaceProperty = ns },
            Data = e.Spec?.Data,
        };
        await client.CoreV1.ReplaceNamespacedConfigMapAsync(body, e.Name, ns, cancellationToken: ct);
    }

    // delete the external object
    protected override async Task DeprovisionDirectAsync(ConfigMapDemo e, CancellationToken ct)
    {
        using var client = await ClientAsync(e, ct);
        await client.CoreV1.DeleteNamespacedConfigMapAsync(e.Name, Ns(e), cancellationToken: ct);
    }

    private static string Ns(ConfigMapDemo e) => e.Spec?.Namespace ?? "default";

    /// <summary>Fresh client per operation — caller owns it: dispose when done (SDK contract).</summary>
    private async Task<IKubernetes> ClientAsync(ConfigMapDemo e, CancellationToken ct)
    {
        var k8s = await _clients.GetKubernetesClientAsync(e.Spec?.ScopeIds ?? new List<string>(), ct);
        if (k8s is null) throw new ArgumentException("Attach a kubernetes scope to this resource.");
        return k8s.Value.Client;
    }
}
