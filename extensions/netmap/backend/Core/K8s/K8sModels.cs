using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Duplo.Extension.NetMap.Core.K8s;

// Safe projections of Kubernetes objects. Parsing copies ONLY the fields listed here out of the API JSON: no env,
// command, args, volumes, secrets, configmaps, service-account tokens or arbitrary annotations ever reach the graph.

public sealed record K8sNamespace(string Name, Dictionary<string, string> Labels);

public sealed record K8sContainer(string Name, string Image);

public sealed record K8sPod(
    string Namespace, string Name, Dictionary<string, string> Labels, string? PodIp, List<string> PodIps, string? Phase,
    string? NodeName, bool HostNetwork, string? OwnerKind, string? OwnerName, List<K8sContainer> Containers);

public sealed record K8sServicePort(string? Name, string Protocol, int Port, string? TargetPort, int? NodePort);

public sealed record K8sService(
    string Namespace, string Name, string Type, string? ClusterIp, Dictionary<string, string> Selector, List<K8sServicePort> Ports,
    List<string> LbHostnames, List<string> LbIps, Dictionary<string, string> Annotations);

public sealed record K8sIngressRule(string? Host, string? Path, string? ServiceName, string? ServicePort);

public sealed record K8sIngress(
    string Namespace, string Name, string? ClassName, List<K8sIngressRule> Rules, List<string> LbHostnames, List<string> LbIps,
    Dictionary<string, string> Annotations);

/// <param name="PodSelector">{matchLabels, matchExpressions} only.</param>
/// <param name="Ingress">[{from:[{ipBlock,namespaceSelector,podSelector}], ports:[{protocol,port,endPort}]}]</param>
/// <param name="Egress">[{to:[…], ports:[…]}]</param>
public sealed record K8sNetworkPolicy(
    string Namespace, string Name, JsonObject PodSelector, List<string> PolicyTypes, JsonArray Ingress, JsonArray Egress);

public sealed record K8sNode(string Name, string? InstanceId, string? InternalIp);

public sealed class K8sObjects
{
    public List<K8sNamespace> Namespaces { get; init; } = new();
    public List<K8sPod> Pods { get; init; } = new();
    public List<K8sService> Services { get; init; } = new();
    public List<K8sIngress> Ingresses { get; init; } = new();
    public List<K8sNetworkPolicy> NetworkPolicies { get; init; } = new();
    public List<K8sNode> Nodes { get; init; } = new();
    public bool PodsTruncated { get; set; }
    /// <summary>Optional lists that could not be read (ingresses, networkpolicies, nodes) with the reason.</summary>
    public List<string> Warnings { get; init; } = new();
}

/// <summary>Kubernetes list JSON → the safe records above.</summary>
public static class K8sParse
{
    public const int MaxLabels = 20;

    /// <summary>Annotations kept: ingress class and AWS load-balancer scheme / type / target type only.</summary>
    public static readonly IReadOnlySet<string> KeptAnnotations = new HashSet<string>(StringComparer.Ordinal)
    {
        "kubernetes.io/ingress.class",
        "service.beta.kubernetes.io/aws-load-balancer-scheme",
        "service.beta.kubernetes.io/aws-load-balancer-internal",
        "service.beta.kubernetes.io/aws-load-balancer-type",
        "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type",
        "alb.ingress.kubernetes.io/scheme",
        "alb.ingress.kubernetes.io/target-type",
        "alb.ingress.kubernetes.io/group.name",
    };

    public static K8sNamespace Namespace(JsonNode item) => new(Str(item["metadata"]?["name"]) ?? "", Labels(item["metadata"]?["labels"]));

    public static K8sPod Pod(JsonNode item)
    {
        var meta = item["metadata"];
        var spec = item["spec"];
        var status = item["status"];
        // all labels here (selectors are matched against them); the normalizer caps what it stores
        var labels = Map(meta?["labels"], int.MaxValue);
        var (ownerKind, ownerName) = Owner(meta?["ownerReferences"] as JsonArray, labels);
        var podIps = (status?["podIPs"] as JsonArray ?? new JsonArray()).Select(p => Str(p?["ip"])).OfType<string>().ToList();
        var podIp = Str(status?["podIP"]);
        if (podIp != null && !podIps.Contains(podIp)) podIps.Insert(0, podIp);
        var containers = (spec?["containers"] as JsonArray ?? new JsonArray())
            .Select(c => new K8sContainer(Str(c?["name"]) ?? "", Str(c?["image"]) ?? "")).ToList();
        return new K8sPod(Str(meta?["namespace"]) ?? "default", Str(meta?["name"]) ?? "", labels, podIp, podIps, Str(status?["phase"]),
            Str(spec?["nodeName"]), Bool(spec?["hostNetwork"]), ownerKind, ownerName, containers);
    }

    /// <summary>Deployment from its ReplicaSet (name minus the pod-template-hash suffix); other owners as-is.</summary>
    public static (string? Kind, string? Name) Owner(JsonArray? refs, IReadOnlyDictionary<string, string> labels)
    {
        var r = refs?.FirstOrDefault(x => Bool(x?["controller"])) ?? refs?.FirstOrDefault();
        var kind = Str(r?["kind"]);
        var name = Str(r?["name"]);
        if (kind == "ReplicaSet" && name != null)
        {
            if (labels.TryGetValue("pod-template-hash", out var hash) && name.EndsWith("-" + hash, StringComparison.Ordinal))
                return ("Deployment", name[..^(hash.Length + 1)]);
            var m = Regex.Match(name, @"^(.+)-[a-z0-9]{8,10}$");
            if (m.Success) return ("Deployment", m.Groups[1].Value);
        }
        if (kind == "Job" && name != null && Regex.Match(name, @"^(.+)-\d{8,}$") is { Success: true } j) return ("CronJob", j.Groups[1].Value);
        return (kind, name);
    }

    public static K8sService Service(JsonNode item)
    {
        var meta = item["metadata"];
        var spec = item["spec"];
        var ports = (spec?["ports"] as JsonArray ?? new JsonArray()).Select(p => new K8sServicePort(
            Str(p?["name"]), Str(p?["protocol"]) ?? "TCP", Int(p?["port"]) ?? 0, Scalar(p?["targetPort"]), Int(p?["nodePort"]))).ToList();
        var lb = status(item);
        return new K8sService(Str(meta?["namespace"]) ?? "default", Str(meta?["name"]) ?? "", Str(spec?["type"]) ?? "ClusterIP",
            Str(spec?["clusterIP"]), Map(spec?["selector"], int.MaxValue), ports, lb.Hosts, lb.Ips, Annotations(meta?["annotations"]));
    }

    public static K8sIngress Ingress(JsonNode item)
    {
        var meta = item["metadata"];
        var spec = item["spec"];
        var rules = new List<K8sIngressRule>();
        if (spec?["defaultBackend"]?["service"] is { } db)
            rules.Add(new K8sIngressRule(null, null, Str(db["name"]), Scalar(db["port"]?["number"]) ?? Str(db["port"]?["name"])));
        foreach (var rule in spec?["rules"] as JsonArray ?? new JsonArray())
        {
            var host = Str(rule?["host"]);
            var paths = rule?["http"]?["paths"] as JsonArray;
            if (paths == null || paths.Count == 0) { rules.Add(new K8sIngressRule(host, null, null, null)); continue; }
            foreach (var p in paths)
            {
                var svc = p?["backend"]?["service"];
                rules.Add(new K8sIngressRule(host, Str(p?["path"]), Str(svc?["name"]), Scalar(svc?["port"]?["number"]) ?? Str(svc?["port"]?["name"])));
            }
        }
        var lb = status(item);
        var annotations = Annotations(meta?["annotations"]);
        return new K8sIngress(Str(meta?["namespace"]) ?? "default", Str(meta?["name"]) ?? "",
            Str(spec?["ingressClassName"]) ?? annotations.GetValueOrDefault("kubernetes.io/ingress.class"), rules, lb.Hosts, lb.Ips, annotations);
    }

    public static K8sNetworkPolicy NetworkPolicy(JsonNode item)
    {
        var meta = item["metadata"];
        var spec = item["spec"];
        var types = (spec?["policyTypes"] as JsonArray ?? new JsonArray()).Select(Str).OfType<string>().ToList();
        var ingress = Rules(spec?["ingress"] as JsonArray, "from");
        var egress = Rules(spec?["egress"] as JsonArray, "to");
        // Kubernetes default: Ingress always, Egress when egress rules are present.
        if (types.Count == 0) { types.Add("Ingress"); if (egress.Count > 0) types.Add("Egress"); }
        return new K8sNetworkPolicy(Str(meta?["namespace"]) ?? "default", Str(meta?["name"]) ?? "", Selector(spec?["podSelector"]) ?? new JsonObject(),
            types, ingress, egress);
    }

    public static K8sNode Node(JsonNode item)
    {
        var provider = Str(item["spec"]?["providerID"]);
        var iid = provider == null ? null : Regex.Match(provider, @"(i-[0-9a-f]+)$") is { Success: true } m ? m.Groups[1].Value : null;
        var ip = (item["status"]?["addresses"] as JsonArray ?? new JsonArray())
            .FirstOrDefault(a => Str(a?["type"]) == "InternalIP") is { } addr ? Str(addr["address"]) : null;
        return new K8sNode(Str(item["metadata"]?["name"]) ?? "", iid, ip);
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    private static (List<string> Hosts, List<string> Ips) status(JsonNode item)
    {
        var ing = item["status"]?["loadBalancer"]?["ingress"] as JsonArray ?? new JsonArray();
        return (ing.Select(i => Str(i?["hostname"])).OfType<string>().ToList(), ing.Select(i => Str(i?["ip"])).OfType<string>().ToList());
    }

    private static JsonArray Rules(JsonArray? rules, string peersKey)
    {
        var result = new JsonArray();
        foreach (var r in rules ?? new JsonArray())
        {
            var o = new JsonObject();
            if (r?[peersKey] is JsonArray peers)
            {
                var list = new JsonArray();
                foreach (var p in peers)
                {
                    var peer = new JsonObject();
                    if (p?["ipBlock"] is JsonObject ib)
                        peer["ipBlock"] = new JsonObject
                        {
                            ["cidr"] = Str(ib["cidr"]),
                            ["except"] = new JsonArray((ib["except"] as JsonArray ?? new JsonArray()).Select(Str).OfType<string>().Select(x => (JsonNode?)x).ToArray()),
                        };
                    if (Selector(p?["namespaceSelector"]) is { } ns) peer["namespaceSelector"] = ns;
                    if (Selector(p?["podSelector"]) is { } ps) peer["podSelector"] = ps;
                    list.Add(peer);
                }
                o[peersKey] = list;
            }
            if (r?["ports"] is JsonArray ports)
                o["ports"] = new JsonArray(ports.Select(p =>
                {
                    var po = new JsonObject { ["protocol"] = Str(p?["protocol"]) ?? "TCP" };
                    if (Scalar(p?["port"]) is { } port) po["port"] = int.TryParse(port, out var n) ? n : port;
                    if (Int(p?["endPort"]) is { } end) po["endPort"] = end;
                    return (JsonNode?)po;
                }).ToArray());
            result.Add(o);
        }
        return result;
    }

    /// <summary>A label selector reduced to matchLabels / matchExpressions; null when absent.</summary>
    public static JsonObject? Selector(JsonNode? sel)
    {
        if (sel is not JsonObject so) return null;
        var o = new JsonObject();
        if (so["matchLabels"] is JsonObject ml)
            o["matchLabels"] = new JsonObject(ml.Where(kv => Str(kv.Value) != null).Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)Str(kv.Value))));
        if (so["matchExpressions"] is JsonArray me)
            o["matchExpressions"] = new JsonArray(me.Select(x => (JsonNode?)new JsonObject
            {
                ["key"] = Str(x?["key"]),
                ["operator"] = Str(x?["operator"]),
                ["values"] = new JsonArray((x?["values"] as JsonArray ?? new JsonArray()).Select(Str).OfType<string>().Select(v => (JsonNode?)v).ToArray()),
            }).ToArray());
        return o;
    }

    public static Dictionary<string, string> Labels(JsonNode? labels) => Map(labels, MaxLabels);

    private static Dictionary<string, string> Annotations(JsonNode? a) =>
        Map(a, int.MaxValue).Where(kv => KeptAnnotations.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

    private static Dictionary<string, string> Map(JsonNode? node, int cap)
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        if (node is not JsonObject o) return d;
        foreach (var (k, v) in o.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            if (d.Count >= cap) break;
            if (Str(v) is { } s) d[k] = s;
        }
        return d;
    }

    private static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    private static int? Int(JsonNode? n) => n is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;
    private static bool Bool(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;
    private static string? Scalar(JsonNode? n) => Str(n) ?? Int(n)?.ToString();
}

/// <summary>Kubernetes label selector semantics: matchLabels AND every matchExpression (In, NotIn, Exists,
/// DoesNotExist). An empty selector selects everything.</summary>
public static class LabelSelector
{
    public static bool Matches(JsonObject? selector, IReadOnlyDictionary<string, string> labels)
    {
        if (selector == null) return false;
        if (selector["matchLabels"] is JsonObject ml)
            foreach (var (k, v) in ml)
                if (!labels.TryGetValue(k, out var actual) || actual != (v as JsonValue)?.GetValue<string>()) return false;
        if (selector["matchExpressions"] is JsonArray me)
            foreach (var x in me)
            {
                var key = (x?["key"] as JsonValue)?.GetValue<string>() ?? "";
                var op = (x?["operator"] as JsonValue)?.GetValue<string>() ?? "";
                var values = (x?["values"] as JsonArray ?? new JsonArray()).OfType<JsonValue>().Select(v => v.GetValue<string>()).ToList();
                var has = labels.TryGetValue(key, out var val);
                var ok = op switch
                {
                    "In" => has && values.Contains(val!),
                    "NotIn" => !has || !values.Contains(val!),
                    "Exists" => has,
                    "DoesNotExist" => !has,
                    _ => false,
                };
                if (!ok) return false;
            }
        return true;
    }

    /// <summary>A service's spec.selector (plain map): empty selects nothing (endpoints are managed by hand).</summary>
    public static bool MatchesMap(IReadOnlyDictionary<string, string> selector, IReadOnlyDictionary<string, string> labels) =>
        selector.Count > 0 && selector.All(kv => labels.TryGetValue(kv.Key, out var v) && v == kv.Value);
}
