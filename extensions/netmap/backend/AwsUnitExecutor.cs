using Amazon.EC2;
using Amazon.ECS;
using Amazon.EKS;
using Amazon.Lambda;
using Amazon.Runtime;
using Amazon.SecurityToken;
using Amazon.ElasticLoadBalancing;
using Amazon.ElasticLoadBalancingV2;
using Amazon.NetworkFirewall;
using Amazon.Route53;
using Amazon.Route53Resolver;
using Duplo.Ai.Studio.Extensibility.Infra;
using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Aws.Fetch;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap;

/// <summary>Runs one work unit: resolves its collector, builds the context (members of the unit's scope+region,
/// best-known account id, priors) and AWS clients bound to that ONE scope.</summary>
internal sealed class AwsUnitExecutor : IUnitExecutor
{
    private readonly IScopeClientFactory _factory;
    private readonly IReadOnlyList<BlueprintMember> _members;
    private readonly IReadOnlyDictionary<string, string> _accounts;

    public AwsUnitExecutor(IScopeClientFactory factory, IReadOnlyList<BlueprintMember> members, IReadOnlyDictionary<string, string> accounts)
    {
        _factory = factory;
        _members = members;
        _accounts = accounts;
    }

    public async Task<GraphPart> ExecuteAsync(WorkUnit unit, IReadOnlyList<GraphPart> priors, CancellationToken ct)
    {
        var collector = CollectorCatalog.Get(unit.Collector);
        var global = unit.Region == ScanPlanner.GlobalRegion;
        var scopeMembers = _members.Where(m => m.ScopeId == unit.ScopeId && (global || m.Region == unit.Region)).ToList();
        var account = _accounts.GetValueOrDefault(unit.ScopeId) ?? ScanAccounts.FromParts(priors) ?? "unknown";
        var ctx = new CollectorContext(unit.ScopeId, account, unit.Region,
            scopeMembers.Select(m => m.NetworkId).Distinct(StringComparer.Ordinal).ToList(), scopeMembers, priors, DateTime.UtcNow);

        using var aws = new ScopedAwsClients(_factory, unit.ScopeId, global ? "us-east-1" : unit.Region);
        return await collector.CollectAsync(ctx, aws, ct);
    }
}

internal sealed class ScopedAwsClients : IAwsClients
{
    private readonly IScopeClientFactory _factory;
    private readonly string[] _scope;
    private readonly string _region;
    private readonly List<IDisposable> _created = new();
    private IAmazonEC2? _ec2;
    private IAmazonElasticLoadBalancingV2? _elbv2;
    private IAmazonElasticLoadBalancing? _elb;
    private IAmazonNetworkFirewall? _nfw;
    private IAmazonRoute53? _r53;
    private IAmazonRoute53Resolver? _resolver;
    private IAmazonEKS? _eks;
    private IAmazonECS? _ecs;
    private IAmazonLambda? _lambda;
    private IAmazonSecurityTokenService? _sts;
    private AWSCredentials? _credentials;

    public ScopedAwsClients(IScopeClientFactory factory, string scopeId, string region)
    {
        _factory = factory;
        _scope = new[] { scopeId };
        _region = region;
    }

    public async Task<IAmazonEC2> Ec2(CancellationToken ct) =>
        _ec2 ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => new AmazonEC2Client(c, r), ct: ct));
    public async Task<IAmazonElasticLoadBalancingV2> Elbv2(CancellationToken ct) =>
        _elbv2 ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => new AmazonElasticLoadBalancingV2Client(c, r), ct: ct));
    public async Task<IAmazonElasticLoadBalancing> Elb(CancellationToken ct) =>
        _elb ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => new AmazonElasticLoadBalancingClient(c, r), ct: ct));
    public async Task<IAmazonNetworkFirewall> NetworkFirewall(CancellationToken ct) =>
        _nfw ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => new AmazonNetworkFirewallClient(c, r), ct: ct));
    public async Task<IAmazonRoute53> Route53(CancellationToken ct) =>
        _r53 ??= Track(await _factory.CreateAwsClientAsync(_scope, "us-east-1", (c, r) => new AmazonRoute53Client(c, r), ct: ct));
    public async Task<IAmazonRoute53Resolver> Resolver(CancellationToken ct) =>
        _resolver ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => new AmazonRoute53ResolverClient(c, r), ct: ct));

    public async Task<IAmazonEKS> Eks(CancellationToken ct) =>
        _eks ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => { _credentials ??= c; return new AmazonEKSClient(c, r); }, ct: ct));
    public async Task<IAmazonECS> Ecs(CancellationToken ct) =>
        _ecs ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => new AmazonECSClient(c, r), ct: ct));
    public async Task<IAmazonLambda> Lambda(CancellationToken ct) =>
        _lambda ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => new AmazonLambdaClient(c, r), ct: ct));
    public async Task<IAmazonSecurityTokenService> Sts(CancellationToken ct) =>
        _sts ??= Track(await _factory.CreateAwsClientAsync(_scope, _region, (c, r) => { _credentials ??= c; return new AmazonSecurityTokenServiceClient(c, r); }, ct: ct));

    /// <summary>The scope's credentials as handed to the client constructor (the factory exposes them no other way);
    /// used only to sign the EKS bearer token.</summary>
    public async Task<ImmutableCredentials> Credentials(CancellationToken ct)
    {
        if (_credentials == null) await Eks(ct);
        return await _credentials!.GetCredentialsAsync();
    }

    private T Track<T>(T client) where T : IDisposable
    {
        _created.Add(client);
        return client;
    }

    public void Dispose()
    {
        foreach (var c in _created) c.Dispose();
    }
}
