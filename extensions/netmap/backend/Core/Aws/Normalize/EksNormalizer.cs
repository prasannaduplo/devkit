using System.Text.Json.Nodes;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.K8s;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

/// <summary>What eks:DescribeCluster says about a cluster (no endpoint URL, CA or token -- those never reach the graph).</summary>
public sealed record EksClusterInfo(
    string Name, string? Arn, string VpcId, string? Version, string? Status, bool? EndpointPublicAccess, bool? EndpointPrivateAccess,
    List<string> SubnetIds, List<string> SecurityGroupIds, string? ClusterSecurityGroupId, string? AuthenticationMode);

/// <param name="Objects">Null when the API could not be read.</param>
/// <param name="Unreadable">Why not (the access the operator must grant), when Objects is null.</param>
/// <param name="AccessDenied">401/403/unreachable, as opposed to e.g. a cluster that is not ACTIVE or out of time budget.</param>
public sealed record EksClusterData(EksClusterInfo Info, K8sObjects? Objects, string? Unreadable = null, bool AccessDenied = false);

public sealed record EksData(List<EksClusterData> Clusters);

/// <summary>EKS clusters in member networks and what their API shows: namespaces, pods (no raw, safe attrs only),
/// services, ingresses and network policies. Links: pod runs-on the ENI holding its IP (else its EC2 node),
/// service / network policy selects pods, ingress backs services, service / ingress backs the load balancer whose DNS
/// name is in status.loadBalancer.ingress, and load balancer exposes pods for ip-mode targets.</summary>
public static class EksNormalizer
{
    public static readonly string Collector = Collectors.Eks.Id;

    /// <summary>Completed pods (Succeeded/Failed) are left out: they hold no address and would only add noise.</summary>
    public static readonly IReadOnlySet<string> SkippedPhases = new HashSet<string>(StringComparer.Ordinal) { "Succeeded", "Failed" };

    public static GraphPart Normalize(CollectorContext ctx, EksData d)
    {
        var b = ctx.Builder(Collector);
        var links = new WorkloadLinks(ctx);
        foreach (var c in d.Clusters) Cluster(ctx, b, links, c);
        var part = b.Build();
        foreach (var c in d.Clusters)
        {
            if (c.Objects == null) part.Warnings.Add($"EKS cluster {c.Info.Name}: not read — needs {c.Unreadable}");
            else
            {
                if (c.Objects.PodsTruncated) part.Warnings.Add($"EKS cluster {c.Info.Name}: pods truncated at {K8sReader.MaxPods}");
                part.Warnings.AddRange(c.Objects.Warnings.Select(w => $"EKS cluster {c.Info.Name}: {w}"));
            }
        }
        return part;
    }

    public static string ClusterId(CollectorContext ctx, string cluster) => ctx.Id(NodeKinds.K8sCluster, cluster);
    public static string NamespaceId(CollectorContext ctx, string cluster, string ns) => ctx.Id(NodeKinds.K8sNamespace, $"{cluster}/{ns}");
    public static string PodId(CollectorContext ctx, string cluster, string ns, string name) => ctx.Id(NodeKinds.Pod, $"{cluster}/{ns}/{name}");
    public static string ServiceId(CollectorContext ctx, string cluster, string ns, string name) => ctx.Id(NodeKinds.K8sService, $"{cluster}/{ns}/{name}");

    private static void Cluster(CollectorContext ctx, PartBuilder b, WorkloadLinks links, EksClusterData c)
    {
        var info = c.Info;
        var cn = info.Name;
        var o = c.Objects;
        var cluster = b.Node(ClusterId(ctx, cn), NodeKinds.K8sCluster, cn, ctx.Account, ctx.Region)
            .Under(ctx.NetworkId(info.VpcId)).SetState(info.Status?.ToLowerInvariant())
            .Attr("clusterType", "eks").Attr("arn", info.Arn).Attr("version", info.Version)
            .Attr("endpointPublicAccess", info.EndpointPublicAccess).Attr("endpointPrivateAccess", info.EndpointPrivateAccess)
            .Attr("authenticationMode", info.AuthenticationMode)
            .Attr("subnetIds", NodeExtensions.Arr(info.SubnetIds))
            .Attr("readable", o != null).Attr("unreadableReason", c.Unreadable).Attr("accessDenied", c.AccessDenied ? true : null);
        foreach (var sg in info.SecurityGroupIds.Append(info.ClusterSecurityGroupId).OfType<string>().Distinct())
            b.Edge(cluster.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.SecurityGroup, sg));
        if (o == null) return;

        var pods = o.Pods.Where(p => p.Phase == null || !SkippedPhases.Contains(p.Phase)).ToList();
        cluster.Attr("podsTruncated", o.PodsTruncated ? true : null).Attr("podCount", pods.Count).Attr("serviceCount", o.Services.Count);

        // keep every label a selector in this cluster looks at, then fill up to the cap
        var selectorKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var s in o.Services) selectorKeys.UnionWith(s.Selector.Keys);
        foreach (var np in o.NetworkPolicies) selectorKeys.UnionWith(SelectorKeys(np.PodSelector).Concat(PeerSelectorKeys(np.Ingress)).Concat(PeerSelectorKeys(np.Egress)));

        var nsNames = o.Namespaces.Select(n => n.Name).Concat(pods.Select(p => p.Namespace)).Concat(o.Services.Select(s => s.Namespace))
            .Concat(o.Ingresses.Select(i => i.Namespace)).Concat(o.NetworkPolicies.Select(n => n.Namespace)).Distinct(StringComparer.Ordinal);
        var nsLabels = o.Namespaces.ToDictionary(n => n.Name, n => n.Labels, StringComparer.Ordinal);
        foreach (var ns in nsNames)
        {
            var labels = new Dictionary<string, string>(nsLabels.GetValueOrDefault(ns) ?? new(), StringComparer.Ordinal)
            {
                ["kubernetes.io/metadata.name"] = ns,
            };
            b.Node(NamespaceId(ctx, cn, ns), NodeKinds.K8sNamespace, $"{cn}/{ns}", ctx.Account, ctx.Region).Named(ns).Under(cluster.Id)
                .Attr("cluster", cn).Attr("namespace", ns).Attr("labels", WorkloadLinks.Map(labels))
                .Attr("podCount", pods.Count(p => p.Namespace == ns));
        }

        var nodes = o.Nodes.ToDictionary(n => n.Name, StringComparer.Ordinal);
        var podById = new Dictionary<string, K8sPod>(StringComparer.Ordinal);
        var podByIp = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var p in pods)
        {
            var id = PodId(ctx, cn, p.Namespace, p.Name);
            podById[id] = p;
            var node = p.NodeName != null ? nodes.GetValueOrDefault(p.NodeName) : null;
            var n = b.Node(id, NodeKinds.Pod, $"{cn}/{p.Namespace}/{p.Name}", ctx.Account, ctx.Region).Named(p.Name)
                .Under(NamespaceId(ctx, cn, p.Namespace)).SetState(p.Phase?.ToLowerInvariant())
                .Attr("cluster", cn).Attr("namespace", p.Namespace).Attr("phase", p.Phase).Attr("podIp", p.PodIp)
                .Attr("podIps", NodeExtensions.Arr(p.PodIps)).Attr("nodeName", p.NodeName).Attr("instanceId", node?.InstanceId)
                .Attr("hostNetwork", p.HostNetwork ? true : null).Attr("ownerKind", p.OwnerKind).Attr("ownerName", p.OwnerName)
                .Attr("labels", WorkloadLinks.Map(CapLabels(p.Labels, selectorKeys)))
                .Attr("containers", WorkloadLinks.Containers(p.Containers.Select(x => (x.Name, x.Image))))
                .Attr("images", NodeExtensions.Arr(p.Containers.Select(x => x.Image).Distinct()));
            // pods carry no raw (keeps snapshots small; everything useful is in attrs)

            var eni = links.EniFor(info.VpcId, p.PodIp);
            if (eni != null) b.Edge(n.Id, EdgeKinds.RunsOn, eni).Attr("ip", p.PodIp);
            else if (node?.InstanceId is { } iid && links.HasWorkload(ctx.Id(NodeKinds.Workload, iid)))
                b.Edge(n.Id, EdgeKinds.RunsOn, ctx.Id(NodeKinds.Workload, iid)).Attr("ip", p.PodIp);
            if (!p.HostNetwork) foreach (var ip in p.PodIps) podByIp.TryAdd(ip, n.Id);
        }

        foreach (var s in o.Services)
        {
            var lbIds = s.LbHostnames.Select(links.LbByDns).OfType<string>().Distinct().ToList();
            var scheme = lbIds.Select(id => links.LoadBalancers.FirstOrDefault(l => l.Id == id)?.AttrString("scheme")).FirstOrDefault(x => x != null)
                ?? ServiceScheme(s);
            var n = b.Node(ServiceId(ctx, cn, s.Namespace, s.Name), NodeKinds.K8sService, $"{cn}/{s.Namespace}/{s.Name}", ctx.Account, ctx.Region)
                .Named(s.Name).Under(NamespaceId(ctx, cn, s.Namespace))
                .Attr("cluster", cn).Attr("namespace", s.Namespace).Attr("serviceType", s.Type).Attr("clusterIp", s.ClusterIp)
                .Attr("selector", WorkloadLinks.Map(s.Selector)).Attr("scheme", s.Type == "LoadBalancer" ? scheme : null)
                .Attr("ports", new JsonArray(s.Ports.Select(p => (JsonNode?)new JsonObject
                {
                    ["name"] = p.Name, ["protocol"] = p.Protocol, ["port"] = p.Port, ["targetPort"] = p.TargetPort, ["nodePort"] = p.NodePort,
                }).ToArray()))
                .Attr("lbHostnames", NodeExtensions.Arr(s.LbHostnames)).Attr("lbIps", NodeExtensions.Arr(s.LbIps))
                .Attr("annotations", s.Annotations.Count > 0 ? WorkloadLinks.Map(s.Annotations) : null);
            foreach (var (pid, p) in podById)
                if (p.Namespace == s.Namespace && LabelSelector.MatchesMap(s.Selector, p.Labels)) b.Edge(n.Id, EdgeKinds.Selects, pid);
            foreach (var lb in lbIds) b.Edge(n.Id, EdgeKinds.Backs, lb);
        }

        foreach (var i in o.Ingresses)
        {
            var lbIds = i.LbHostnames.Select(links.LbByDns).OfType<string>().Distinct().ToList();
            var scheme = lbIds.Select(id => links.LoadBalancers.FirstOrDefault(l => l.Id == id)?.AttrString("scheme")).FirstOrDefault(x => x != null)
                ?? i.Annotations.GetValueOrDefault("alb.ingress.kubernetes.io/scheme");
            var n = b.Node(ctx.Id(NodeKinds.Ingress, $"{cn}/{i.Namespace}/{i.Name}"), NodeKinds.Ingress, $"{cn}/{i.Namespace}/{i.Name}", ctx.Account, ctx.Region)
                .Named(i.Name).Under(NamespaceId(ctx, cn, i.Namespace))
                .Attr("cluster", cn).Attr("namespace", i.Namespace).Attr("ingressClass", i.ClassName).Attr("scheme", scheme)
                .Attr("rules", new JsonArray(i.Rules.Select(r => (JsonNode?)new JsonObject
                {
                    ["host"] = r.Host, ["path"] = r.Path, ["service"] = r.ServiceName, ["port"] = r.ServicePort,
                }).ToArray()))
                .Attr("lbHostnames", NodeExtensions.Arr(i.LbHostnames)).Attr("lbIps", NodeExtensions.Arr(i.LbIps))
                .Attr("annotations", i.Annotations.Count > 0 ? WorkloadLinks.Map(i.Annotations) : null);
            foreach (var svc in i.Rules.Select(r => r.ServiceName).OfType<string>().Distinct())
                if (o.Services.Any(s => s.Namespace == i.Namespace && s.Name == svc)) b.Edge(n.Id, EdgeKinds.Backs, ServiceId(ctx, cn, i.Namespace, svc));
            foreach (var lb in lbIds) b.Edge(n.Id, EdgeKinds.Backs, lb);
        }

        foreach (var np in o.NetworkPolicies)
        {
            var n = b.Node(ctx.Id(NodeKinds.NetworkPolicy, $"{cn}/{np.Namespace}/{np.Name}"), NodeKinds.NetworkPolicy, $"{cn}/{np.Namespace}/{np.Name}", ctx.Account, ctx.Region)
                .Named(np.Name).Under(NamespaceId(ctx, cn, np.Namespace))
                .Attr("cluster", cn).Attr("namespace", np.Namespace).Attr("podSelector", np.PodSelector.DeepClone())
                .Attr("policyTypes", NodeExtensions.Arr(np.PolicyTypes)).Attr("ingress", np.Ingress.DeepClone()).Attr("egress", np.Egress.DeepClone());
            foreach (var (pid, p) in podById)
                if (p.Namespace == np.Namespace && LabelSelector.Matches(np.PodSelector, p.Labels)) b.Edge(n.Id, EdgeKinds.Selects, pid);
        }

        links.Exposes(b, podByIp);
    }

    /// <summary>Scheme from annotations: the AWS Load Balancer Controller's scheme annotation, the legacy internal flag,
    /// else the in-tree default (internet-facing). Null when it cannot be told.</summary>
    public static string? ServiceScheme(K8sService s)
    {
        if (s.Annotations.TryGetValue("service.beta.kubernetes.io/aws-load-balancer-scheme", out var sc)) return sc;
        if (s.Annotations.TryGetValue("service.beta.kubernetes.io/aws-load-balancer-internal", out var internalFlag))
            return internalFlag is "true" or "0.0.0.0/0" ? "internal" : "internet-facing";
        // the AWS Load Balancer Controller defaults to internal; the legacy in-tree provider to internet-facing
        var type = s.Annotations.GetValueOrDefault("service.beta.kubernetes.io/aws-load-balancer-type");
        return type is "external" or "nlb-ip" ? "internal" : s.Type == "LoadBalancer" ? "internet-facing" : null;
    }

    internal static Dictionary<string, string> CapLabels(IReadOnlyDictionary<string, string> labels, IReadOnlySet<string> keep)
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (k, v) in labels.Where(kv => keep.Contains(kv.Key))) d[k] = v;
        foreach (var (k, v) in labels.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            if (d.Count >= K8sParse.MaxLabels) break;
            d.TryAdd(k, v);
        }
        return d;
    }

    private static IEnumerable<string> SelectorKeys(JsonNode? sel) =>
        ((sel?["matchLabels"] as JsonObject)?.Select(kv => kv.Key) ?? Enumerable.Empty<string>())
            .Concat((sel?["matchExpressions"] as JsonArray ?? new JsonArray()).Select(x => (x?["key"] as JsonValue)?.GetValue<string>()).OfType<string>());

    private static IEnumerable<string> PeerSelectorKeys(JsonArray rules) =>
        rules.SelectMany(r => (r?["from"] as JsonArray ?? r?["to"] as JsonArray ?? new JsonArray()))
            .SelectMany(p => SelectorKeys(p?["podSelector"]));
}
