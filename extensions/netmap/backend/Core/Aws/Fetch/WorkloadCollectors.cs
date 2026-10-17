using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Amazon.ECS;
using Amazon.EKS.Model;
using Amazon.Lambda.Model;
using Amazon.Runtime;
using Amazon.SecurityToken.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.K8s;
using Duplo.Extension.NetMap.Core.Scan;
using Ecs = Amazon.ECS.Model;

namespace Duplo.Extension.NetMap.Core.Aws.Fetch;

/// <summary>EKS clusters whose VPC is a member network, and -- through the Kubernetes API with an EKS bearer token
/// signed by the scope's own credentials, TLS pinned to the cluster CA -- their namespaces, pods, services,
/// ingresses, network policies and nodes. Read-only GET/LIST only; never Secrets or ConfigMaps. A cluster the
/// identity cannot read (401/403/unreachable) is kept as an unreadable cluster node; when no member cluster is
/// readable the unit ends denied with the access to grant as its missing permission.</summary>
public sealed class EksCollector : ICollector
{
    public const int MaxClusters = 20;
    public const int Parallelism = 3;
    /// <summary>No new cluster read starts after this much of the unit (unit cap is 85 s, engine budget 60 s).</summary>
    public static readonly TimeSpan SoftBudget = TimeSpan.FromSeconds(45);
    public static readonly TimeSpan ClusterTimeout = TimeSpan.FromSeconds(35);

    private readonly EksToken _token;
    private readonly Func<X509Certificate2, HttpMessageHandler> _handlerFactory;
    private readonly Func<DateTime> _clock;

    public EksCollector() : this(null, null, null) { }

    public EksCollector(EksToken? token, Func<X509Certificate2, HttpMessageHandler>? handlerFactory, Func<DateTime>? clock)
    {
        _token = token ?? new EksToken();
        _handlerFactory = handlerFactory ?? ClusterCa.Handler;
        _clock = clock ?? (() => DateTime.UtcNow);
    }

    public CollectorDescriptor Descriptor => Collectors.Eks;

    private sealed record Target(EksClusterInfo Info, Uri? Endpoint, string? CaData);

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var start = _clock();
        var warnings = new List<string>();
        var eks = await aws.Eks(ct);

        var names = new List<string>();
        await foreach (var name in eks.Paginators.ListClusters(new ListClustersRequest()).Clusters.WithCancellation(ct))
        {
            if (names.Count >= MaxClusters) { warnings.Add($"more than {MaxClusters} EKS clusters in {ctx.Region}; only the first {MaxClusters} were checked"); break; }
            names.Add(name);
        }
        if (names.Count == 0) return new GraphPart();

        var vpcs = ctx.MemberVpcIds.ToHashSet(StringComparer.Ordinal);
        var targets = new List<Target>();
        foreach (var name in names)
        {
            var c = (await eks.DescribeClusterAsync(new DescribeClusterRequest { Name = name }, ct)).Cluster;
            var vpc = c.ResourcesVpcConfig?.VpcId;
            if (vpc == null || !vpcs.Contains(vpc)) continue;
            var info = new EksClusterInfo(c.Name, c.Arn, vpc, c.Version, c.Status?.Value, c.ResourcesVpcConfig?.EndpointPublicAccess,
                c.ResourcesVpcConfig?.EndpointPrivateAccess, Aws.L(c.ResourcesVpcConfig?.SubnetIds), Aws.L(c.ResourcesVpcConfig?.SecurityGroupIds),
                c.ResourcesVpcConfig?.ClusterSecurityGroupId, c.AccessConfig?.AuthenticationMode?.Value);
            targets.Add(new Target(info, Uri.TryCreate(c.Endpoint, UriKind.Absolute, out var u) ? u : null, c.CertificateAuthority?.Data));
        }
        if (targets.Count == 0) return new GraphPart { Warnings = warnings };

        var keys = await aws.Credentials(ct);
        var role = await Fetch.Optional(async () =>
        {
            var sts = await aws.Sts(ct);
            return RoleOf((await sts.GetCallerIdentityAsync(new GetCallerIdentityRequest(), ct)).Arn);
        }, (string?)null, warnings, "sts:GetCallerIdentity");

        using var gate = new SemaphoreSlim(Parallelism);
        var results = await System.Threading.Tasks.Task.WhenAll(targets.Select(async t =>
        {
            await gate.WaitAsync(ct);
            try { return await ReadAsync(t, ctx.Region, keys, role, start, ct); }
            finally { gate.Release(); }
        }));

        var part = EksNormalizer.Normalize(ctx, new EksData(results.ToList()));
        part.Warnings.InsertRange(0, warnings);
        if (results.All(r => r.Objects == null && r.AccessDenied))
            throw new CollectorDeniedException(string.Join("; ", results.Select(r => $"{r.Info.Name}: {r.Unreadable}").Distinct()));
        return part;
    }

    private async Task<EksClusterData> ReadAsync(Target t, string region, ImmutableCredentials keys, string? role, DateTime start, CancellationToken ct)
    {
        var info = t.Info;
        if (!string.Equals(info.Status, "ACTIVE", StringComparison.Ordinal)) return new EksClusterData(info, null, $"an ACTIVE cluster (status is {info.Status ?? "unknown"})");
        if (t.Endpoint == null || string.IsNullOrEmpty(t.CaData)) return new EksClusterData(info, null, "an API endpoint and CA in eks:DescribeCluster");
        if (_clock() - start > SoftBudget) return new EksClusterData(info, null, "more scan time (the region's EKS time budget was used up; rescan)");

        X509Certificate2 ca;
        try { ca = ClusterCa.FromBase64Pem(t.CaData); }
        catch (Exception ex) when (ex is FormatException or CryptographicException or ArgumentException)
        {
            return new EksClusterData(info, null, "a parsable cluster CA (certificateAuthority.data)");
        }

        using (ca)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(ClusterTimeout);
            var token = _token.Create(info.Name, region, keys.AccessKey, keys.SecretKey, keys.Token);
            using var http = K8sReader.Client(_handlerFactory(ca), t.Endpoint, token);
            try
            {
                var objects = await new K8sReader(http).ReadAsync(cts.Token);
                return new EksClusterData(info, objects);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && (K8sReader.IsAccessFailure(ex) || ex is OperationCanceledException))
            {
                return new EksClusterData(info, null, K8sReader.DenialText(ex, role, info.EndpointPublicAccess), AccessDenied: true);
            }
            catch (K8sHttpException ex) when (!ct.IsCancellationRequested)
            {
                return new EksClusterData(info, null, $"a working API server (HTTP {ex.Status} from {ex.Path})");
            }
            catch (JsonException) when (!ct.IsCancellationRequested)
            {
                return new EksClusterData(info, null, "an API server answering JSON");
            }
        }
    }

    /// <summary>"arn:aws:sts::123:assumed-role/RoleName/session" → "role RoleName"; other ARNs as-is.</summary>
    public static string? RoleOf(string? arn)
    {
        if (arn == null) return null;
        var m = System.Text.RegularExpressions.Regex.Match(arn, @":assumed-role/([^/]+)/");
        return m.Success ? $"role {m.Groups[1].Value}" : arn;
    }
}

/// <summary>ECS clusters / services / tasks in member networks: ListClusters + DescribeClusters, ListServices +
/// DescribeServices (batches of 10), ListTasks + DescribeTasks (batches of 100, at most 2000 tasks per cluster).
/// Never reads task definitions (environment, secrets).</summary>
public sealed class EcsCollector : ICollector
{
    public const int MaxTasksPerCluster = 2000;
    public const int MaxClusters = 50;

    public CollectorDescriptor Descriptor => Collectors.Ecs;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var ecs = await aws.Ecs(ct);
        var warnings = new List<string>();
        var arns = (await Aws.All(ecs.Paginators.ListClusters(new Ecs.ListClustersRequest()).ClusterArns, ct)).ToList();
        if (arns.Count > MaxClusters) { warnings.Add($"{arns.Count} ECS clusters in {ctx.Region}; only the first {MaxClusters} were read"); arns = arns.Take(MaxClusters).ToList(); }
        if (arns.Count == 0) return new GraphPart { Warnings = warnings };

        var clusters = new List<Ecs.Cluster>();
        foreach (var chunk in arns.Chunk(100))
            clusters.AddRange(Aws.L((await ecs.DescribeClustersAsync(new Ecs.DescribeClustersRequest { Clusters = chunk.ToList() }, ct)).Clusters));

        var data = new List<EcsClusterData>();
        foreach (var c in clusters)
        {
            var serviceArns = await Aws.All(ecs.Paginators.ListServices(new Ecs.ListServicesRequest { Cluster = c.ClusterArn }).ServiceArns, ct);
            var services = new List<Ecs.Service>();
            foreach (var chunk in serviceArns.Chunk(10))
                services.AddRange(Aws.L((await ecs.DescribeServicesAsync(new Ecs.DescribeServicesRequest { Cluster = c.ClusterArn, Services = chunk.ToList() }, ct)).Services));

            var taskArns = new List<string>();
            var truncated = false;
            await foreach (var arn in ecs.Paginators.ListTasks(new Ecs.ListTasksRequest { Cluster = c.ClusterArn }).TaskArns.WithCancellation(ct))
            {
                if (taskArns.Count >= MaxTasksPerCluster) { truncated = true; break; }
                taskArns.Add(arn);
            }
            var tasks = new List<Ecs.Task>();
            foreach (var chunk in taskArns.Chunk(100))
                tasks.AddRange(Aws.L((await ecs.DescribeTasksAsync(new Ecs.DescribeTasksRequest { Cluster = c.ClusterArn, Tasks = chunk.ToList() }, ct)).Tasks));
            data.Add(new EcsClusterData(c, services, tasks, truncated));
        }

        var part = EcsNormalizer.Normalize(ctx, new EcsData(data));
        part.Warnings.InsertRange(0, warnings);
        return part;
    }
}

/// <summary>VPC-attached Lambda functions in member networks: lambda:ListFunctions only (no GetFunction, no code,
/// environment variables dropped before normalizing).</summary>
public sealed class LambdaCollector : ICollector
{
    public const int MaxFunctions = 5000;

    public CollectorDescriptor Descriptor => Collectors.Lambda;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var lambda = await aws.Lambda(ct);
        var vpcs = ctx.MemberVpcIds.ToHashSet(StringComparer.Ordinal);
        var functions = new List<FunctionConfiguration>();
        var seen = 0;
        var warnings = new List<string>();
        await foreach (var f in lambda.Paginators.ListFunctions(new ListFunctionsRequest()).Functions.WithCancellation(ct))
        {
            if (++seen > MaxFunctions) { warnings.Add($"more than {MaxFunctions} Lambda functions in {ctx.Region}; the rest were not checked"); break; }
            if (f.VpcConfig?.VpcId is not { Length: > 0 } vpc || !vpcs.Contains(vpc)) continue;
            f.Environment = null;   // never kept, not even in memory past this point
            functions.Add(f);
        }
        var part = LambdaNormalizer.Normalize(ctx, new LambdaData(functions));
        part.Warnings.AddRange(warnings);
        return part;
    }
}
