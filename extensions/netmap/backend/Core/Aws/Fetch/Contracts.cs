using Amazon.EC2;
using Amazon.ECS;
using Amazon.EKS;
using Amazon.Lambda;
using Amazon.SecurityToken;
using Amazon.EC2.Model;
using Amazon.ElasticLoadBalancing;
using Amazon.ElasticLoadBalancingV2;
using Amazon.NetworkFirewall;
using Amazon.Route53;
using Amazon.Route53Resolver;
using Amazon.Runtime;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Fetch;

/// <summary>AWS clients for ONE scope and ONE region (Route53 is pinned to us-east-1). Created lazily, disposed with
/// the unit. The SDK-bound implementation is ScopedAwsClients (backend/AwsUnitExecutor.cs).</summary>
public interface IAwsClients : IDisposable
{
    Task<IAmazonEC2> Ec2(CancellationToken ct);
    Task<IAmazonElasticLoadBalancingV2> Elbv2(CancellationToken ct);
    Task<IAmazonElasticLoadBalancing> Elb(CancellationToken ct);
    Task<IAmazonNetworkFirewall> NetworkFirewall(CancellationToken ct);
    Task<IAmazonRoute53> Route53(CancellationToken ct);
    Task<IAmazonRoute53Resolver> Resolver(CancellationToken ct);
    Task<IAmazonEKS> Eks(CancellationToken ct);
    Task<IAmazonECS> Ecs(CancellationToken ct);
    Task<IAmazonLambda> Lambda(CancellationToken ct);
    Task<IAmazonSecurityTokenService> Sts(CancellationToken ct);
    /// <summary>The scope's resolved AWS keys, only to sign the EKS bearer token. Never log or store them.</summary>
    Task<ImmutableCredentials> Credentials(CancellationToken ct);
}

public interface ICollector
{
    CollectorDescriptor Descriptor { get; }
    Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct);
}

public static class Fetch
{
    public const int Ec2FilterLimit = 200;

    public static List<Filter> F(string name, IEnumerable<string> values) => new() { new Filter(name, values.ToList()) };

    private static readonly HashSet<string> UnavailableCodes = new(StringComparer.OrdinalIgnoreCase)
        { "InvalidAction", "UnsupportedOperation", "OperationNotPermitted" };

    /// <summary>Denied, not-found or unsupported: the optional data is simply not there for this scope.</summary>
    public static bool IsUnavailable(AmazonServiceException ex)
    {
        if (ErrorClassifier.Classify(ex).Kind == ErrorKind.Denied) return true;
        var code = ex.ErrorCode ?? "";
        return code.EndsWith("NotFound", StringComparison.OrdinalIgnoreCase) || code.EndsWith("NotFoundException", StringComparison.OrdinalIgnoreCase)
            || UnavailableCodes.Contains(code);
    }

    /// <summary>The missing permission when known, else the error code.</summary>
    public static string Reason(AmazonServiceException ex) => ErrorClassifier.Classify(ex).MissingPermission ?? ex.ErrorCode ?? ex.GetType().Name;

    /// <summary>Runs an optional sub-fetch. Denied / not-found / unsupported degrade to <paramref name="fallback"/> plus a
    /// warning; transient errors and cancellation still propagate so the engine retries.</summary>
    public static async Task<T> Optional<T>(Func<Task<T>> call, T fallback, List<string> warnings, string what)
    {
        try { return await call(); }
        catch (AmazonServiceException ex) when (IsUnavailable(ex))
        {
            warnings.Add($"{what}: {Reason(ex)}");
            return fallback;
        }
    }

    public static IEnumerable<List<string>> Chunks(IEnumerable<string> values) =>
        values.Distinct(StringComparer.Ordinal).Chunk(Ec2FilterLimit).Select(c => c.ToList());
}
