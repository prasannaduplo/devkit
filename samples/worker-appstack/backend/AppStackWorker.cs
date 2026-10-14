using System.Net;
using Duplo.Ai.DataManagement.Services.Workers;
using Duplo.Ai.Studio.Extensibility.Infra;
using k8s;
using k8s.Autorest;
using k8s.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.AppStack;

/// <summary>
/// Background worker that reconciles each <see cref="AppStack"/> into a Kubernetes Deployment + Service.
/// The base <see cref="ResourceWorkerBase{TResource,TSpec,TResult}"/> drives the tick loop, status
/// transitions, retries, and the deprovision path; this class supplies the four cluster operations. It
/// resolves the SDK's <see cref="IScopeClientFactory"/> from the per-tick DI scope.
/// </summary>
public class AppStackWorker : ResourceWorkerBase<AppStack, AppStackSpec, AppStackResult>
{
    public AppStackWorker(IServiceScopeFactory scopeFactory, ILogger<AppStackWorker> logger, IConfiguration? config = null)
        : base(scopeFactory, logger, config)
    {
    }

    // Apply Deployment then Service (dependency order). ApplyAsync is the RECONCILE seam — the base
    // re-ticks it (after a partial failure, on drift, on spec change), so every operation here must be
    // IDEMPOTENT: read first, then Create when absent / Replace when present. A create-only apply 409s
    // (AlreadyExists) forever after the first partial run.
    protected override async Task ApplyAsync(AppStack e, IServiceProvider scope, CancellationToken ct)
    {
        // The SDK builds a fresh client per call — dispose it when done (SDK contract).
        using var client = await ClientAsync(e, scope, ct);
        var ns = Ns(e);
        var labels = new Dictionary<string, string> { ["app"] = e.Name };

        var desiredDeploymentSpec = new V1DeploymentSpec
        {
            Replicas = e.Spec?.Replicas ?? 1,
            Selector = new V1LabelSelector { MatchLabels = labels },
            Template = new V1PodTemplateSpec
            {
                Metadata = new V1ObjectMeta { Labels = labels },
                Spec = new V1PodSpec
                {
                    Containers = new List<V1Container>
                    {
                        new V1Container { Name = e.Name, Image = e.Spec?.Image ?? "nginx:latest" },
                    },
                },
            },
        };

        var existingDeployment = await ReadOrNullAsync(
            () => client.AppsV1.ReadNamespacedDeploymentAsync(e.Name, ns, cancellationToken: ct));
        if (existingDeployment is null)
        {
            await client.AppsV1.CreateNamespacedDeploymentAsync(new V1Deployment
            {
                Metadata = new V1ObjectMeta { Name = e.Name, NamespaceProperty = ns },
                Spec = desiredDeploymentSpec,
            }, ns, cancellationToken: ct);
        }
        else
        {
            // Mutate the READ object and Replace: it carries resourceVersion, which the API requires.
            existingDeployment.Spec = desiredDeploymentSpec;
            await client.AppsV1.ReplaceNamespacedDeploymentAsync(existingDeployment, e.Name, ns, cancellationToken: ct);
        }

        var existingService = await ReadOrNullAsync(
            () => client.CoreV1.ReadNamespacedServiceAsync(e.Name, ns, cancellationToken: ct));
        if (existingService is null)
        {
            await client.CoreV1.CreateNamespacedServiceAsync(new V1Service
            {
                Metadata = new V1ObjectMeta { Name = e.Name, NamespaceProperty = ns },
                Spec = new V1ServiceSpec
                {
                    Selector = labels,
                    Ports = new List<V1ServicePort> { new V1ServicePort(80) },
                },
            }, ns, cancellationToken: ct);
        }
        else
        {
            // Update only the mutable bits on the read object — replacing a Service with a fresh spec
            // fails on the immutable clusterIP; the read object preserves it.
            existingService.Spec.Selector = labels;
            existingService.Spec.Ports = new List<V1ServicePort> { new V1ServicePort(80) };
            await client.CoreV1.ReplaceNamespacedServiceAsync(existingService, e.Name, ns, cancellationToken: ct);
        }
    }

    // No-op drift check for the demo.
    protected override Task VerifyDriftAsync(AppStack e, IServiceProvider scope, CancellationToken ct)
        => Task.CompletedTask;

    // Delete in reverse dependency order (Service then Deployment). Idempotent: a missing object is fine.
    protected override async Task DeleteSubResourcesAsync(AppStack e, IServiceProvider scope, CancellationToken ct)
    {
        using var client = await ClientAsync(e, scope, ct);
        var ns = Ns(e);
        await IgnoreNotFoundAsync(() => client.CoreV1.DeleteNamespacedServiceAsync(e.Name, ns, cancellationToken: ct));
        await IgnoreNotFoundAsync(() => client.AppsV1.DeleteNamespacedDeploymentAsync(e.Name, ns, cancellationToken: ct));
    }

    // Done once the Deployment is gone from the cluster.
    protected override async Task<bool> WaitForDeletionAsync(AppStack e, IServiceProvider scope, CancellationToken ct)
    {
        using var client = await ClientAsync(e, scope, ct);
        var deps = await client.AppsV1.ListNamespacedDeploymentAsync(
            Ns(e), fieldSelector: $"metadata.name={e.Name}", cancellationToken: ct);
        return deps.Items.Count == 0;
    }

    private static string Ns(AppStack e) => e.Spec?.Namespace ?? "default";

    /// <summary>Fresh client from the per-tick scope — caller owns it: dispose after each operation.</summary>
    private static async Task<IKubernetes> ClientAsync(AppStack e, IServiceProvider scope, CancellationToken ct)
    {
        var factory = scope.GetRequiredService<IScopeClientFactory>();
        var k8s = await factory.GetKubernetesClientAsync(e.Spec?.ScopeIds ?? new List<string>(), ct);
        if (k8s is null) throw new InvalidOperationException("Attach a kubernetes scope to this resource.");
        return k8s.Value.Client;
    }

    private static async Task<T?> ReadOrNullAsync<T>(Func<Task<T>> read) where T : class
    {
        try { return await read(); }
        catch (HttpOperationException ex) when (ex.Response?.StatusCode == HttpStatusCode.NotFound) { return null; }
    }

    private static async Task IgnoreNotFoundAsync<T>(Func<Task<T>> op)
    {
        try { await op(); }
        catch (HttpOperationException ex) when (ex.Response?.StatusCode == HttpStatusCode.NotFound) { }
    }
}
