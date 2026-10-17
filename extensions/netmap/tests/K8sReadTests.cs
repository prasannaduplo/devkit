using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Duplo.Extension.NetMap.Core.Aws.Fetch;
using Duplo.Extension.NetMap.Core.K8s;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class K8sReadTests
{
    private const string PodJson = """
    {
      "metadata": { "name": "frontend-7d4b9c-abcde", "namespace": "web",
        "labels": { "app": "frontend", "pod-template-hash": "7d4b9c" },
        "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{\"secret\":\"x\"}" },
        "ownerReferences": [ { "kind": "ReplicaSet", "name": "frontend-7d4b9c", "controller": true } ] },
      "spec": { "nodeName": "ip-10-20-1-10.ec2.internal", "serviceAccountName": "frontend",
        "containers": [ { "name": "web", "image": "registry.example.com/frontend:1.4",
          "env": [ { "name": "DB_PASSWORD", "value": "hunter2" } ], "command": ["run", "--token=abc"],
          "volumeMounts": [ { "name": "creds", "mountPath": "/var/run/secrets" } ] } ],
        "volumes": [ { "name": "creds", "secret": { "secretName": "db-creds" } } ] },
      "status": { "phase": "Running", "podIP": "10.20.1.11", "podIPs": [ { "ip": "10.20.1.11" } ] }
    }
    """;

    [Fact]
    public void Pod_projection_keeps_only_safe_fields()
    {
        var p = K8sParse.Pod(JsonNode.Parse(PodJson)!);
        p.Name.Should().Be("frontend-7d4b9c-abcde");
        p.Namespace.Should().Be("web");
        (p.OwnerKind, p.OwnerName).Should().Be(("Deployment", "frontend"));
        p.PodIp.Should().Be("10.20.1.11");
        p.PodIps.Should().Equal("10.20.1.11");
        p.Containers.Should().ContainSingle().Which.Should().Be(new K8sContainer("web", "registry.example.com/frontend:1.4"));
        var all = System.Text.Json.JsonSerializer.Serialize(p);
        all.Should().NotContain("hunter2").And.NotContain("token=abc").And.NotContain("db-creds").And.NotContain("last-applied");
    }

    [Fact]
    public void Owner_trimming_handles_replicasets_without_hash_label_and_cronjobs()
    {
        var rs = JsonNode.Parse("""[{"kind":"ReplicaSet","name":"api-5f6d7c8b9d"}]""") as JsonArray;
        K8sParse.Owner(rs, new Dictionary<string, string>()).Should().Be(("Deployment", "api"));
        var job = JsonNode.Parse("""[{"kind":"Job","name":"report-28934520"}]""") as JsonArray;
        K8sParse.Owner(job, new Dictionary<string, string>()).Should().Be(("CronJob", "report"));
        var ss = JsonNode.Parse("""[{"kind":"StatefulSet","name":"db"}]""") as JsonArray;
        K8sParse.Owner(ss, new Dictionary<string, string>()).Should().Be(("StatefulSet", "db"));
    }

    [Fact]
    public void Service_ingress_and_policy_projection()
    {
        var svc = K8sParse.Service(JsonNode.Parse("""
        { "metadata": { "name": "api", "namespace": "web", "annotations": {
            "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing", "example.com/owner-token": "zzz" } },
          "spec": { "type": "LoadBalancer", "clusterIP": "172.20.0.10", "selector": { "app": "api" },
            "ports": [ { "name": "https", "protocol": "TCP", "port": 443, "targetPort": "http", "nodePort": 31443 } ] },
          "status": { "loadBalancer": { "ingress": [ { "hostname": "api-nlb-0123.elb.us-east-1.amazonaws.com" } ] } } }
        """)!);
        svc.Type.Should().Be("LoadBalancer");
        svc.Selector.Should().Equal(new Dictionary<string, string> { ["app"] = "api" });
        svc.Ports.Should().ContainSingle().Which.Should().Be(new K8sServicePort("https", "TCP", 443, "http", 31443));
        svc.LbHostnames.Should().Equal("api-nlb-0123.elb.us-east-1.amazonaws.com");
        svc.Annotations.Keys.Should().Equal("service.beta.kubernetes.io/aws-load-balancer-scheme");

        var ing = K8sParse.Ingress(JsonNode.Parse("""
        { "metadata": { "name": "frontend", "namespace": "web", "annotations": { "alb.ingress.kubernetes.io/scheme": "internet-facing" } },
          "spec": { "ingressClassName": "alb", "rules": [ { "host": "shop.example.com", "http": { "paths": [
            { "path": "/", "pathType": "Prefix", "backend": { "service": { "name": "frontend", "port": { "number": 80 } } } } ] } } ] },
          "status": { "loadBalancer": { "ingress": [ { "hostname": "web-alb-1.us-east-1.elb.amazonaws.com" } ] } } }
        """)!);
        ing.ClassName.Should().Be("alb");
        ing.Rules.Should().ContainSingle().Which.Should().Be(new K8sIngressRule("shop.example.com", "/", "frontend", "80"));

        var np = K8sParse.NetworkPolicy(JsonNode.Parse("""
        { "metadata": { "name": "allow", "namespace": "web" },
          "spec": { "podSelector": { "matchLabels": { "app": "api" } },
            "egress": [ { "to": [ { "ipBlock": { "cidr": "0.0.0.0/0", "except": ["169.254.169.254/32"] } } ], "ports": [ { "protocol": "TCP", "port": 443 } ] } ] } }
        """)!);
        np.PolicyTypes.Should().Equal("Ingress", "Egress");
        np.Egress[0]!["to"]![0]!["ipBlock"]!["cidr"]!.GetValue<string>().Should().Be("0.0.0.0/0");
        np.Egress[0]!["ports"]![0]!["port"]!.GetValue<int>().Should().Be(443);
        np.Ingress.Should().BeEmpty();

        K8sParse.Node(JsonNode.Parse("""{"metadata":{"name":"n1"},"spec":{"providerID":"aws:///us-east-1a/i-0abc123"},"status":{"addresses":[{"type":"InternalIP","address":"10.20.1.10"}]}}""")!)
            .Should().Be(new K8sNode("n1", "i-0abc123", "10.20.1.10"));
    }

    [Fact]
    public void Label_selectors_follow_kubernetes_semantics()
    {
        var labels = new Dictionary<string, string> { ["app"] = "api", ["tier"] = "web" };
        LabelSelector.Matches(new JsonObject(), labels).Should().BeTrue();
        LabelSelector.Matches(null, labels).Should().BeFalse();
        LabelSelector.Matches(JsonNode.Parse("""{"matchLabels":{"app":"api"}}""")!.AsObject(), labels).Should().BeTrue();
        LabelSelector.Matches(JsonNode.Parse("""{"matchLabels":{"app":"web"}}""")!.AsObject(), labels).Should().BeFalse();
        LabelSelector.Matches(JsonNode.Parse("""{"matchExpressions":[{"key":"tier","operator":"In","values":["web","db"]},{"key":"canary","operator":"DoesNotExist"}]}""")!.AsObject(), labels).Should().BeTrue();
        LabelSelector.Matches(JsonNode.Parse("""{"matchExpressions":[{"key":"tier","operator":"NotIn","values":["web"]}]}""")!.AsObject(), labels).Should().BeFalse();
        LabelSelector.MatchesMap(new Dictionary<string, string>(), labels).Should().BeFalse();
    }

    private sealed class FakeApi : HttpMessageHandler
    {
        public List<string> Seen { get; } = new();
        public Func<string, HttpResponseMessage?> Override { get; set; } = _ => null;
        public int PodPages { get; set; } = 3;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            req.Method.Should().Be(HttpMethod.Get);
            req.Headers.Authorization!.Scheme.Should().Be("Bearer");
            var path = req.RequestUri!.AbsolutePath;
            Seen.Add(req.RequestUri.PathAndQuery);
            if (Override(path) is { } r) return Task.FromResult(r);
            var query = req.RequestUri.Query;
            if (path == "/api/v1/pods")
            {
                var page = query.Contains("continue=p") ? int.Parse(query[(query.IndexOf("continue=p", StringComparison.Ordinal) + 10)..]) : 0;
                var items = string.Join(",", Enumerable.Range(0, K8sReader.PageSize).Select(i =>
                    $$$"""{"metadata":{"name":"w-{{{page}}}-{{{i}}}","namespace":"batch"},"status":{"phase":"Running","podIP":"10.20.{{{page}}}.{{{i % 250}}}"}}"""));
                var cont = page + 1 < PodPages ? $"\"p{page + 1}\"" : "null";
                return Task.FromResult(Json($$$"""{"metadata":{"continue":{{{cont}}}},"items":[{{{items}}}]}"""));
            }
            return Task.FromResult(Json("""{"metadata":{},"items":[{"metadata":{"name":"x","namespace":"web"}}]}"""));
        }
    }

    private static HttpResponseMessage Json(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static K8sReader Reader(FakeApi api) => new(K8sReader.Client(api, new Uri("https://api.example.eks.amazonaws.com"), "k8s-aws-v1.not-a-real-token"));

    [Fact]
    public async Task Reads_only_the_allowed_paths_and_paginates_with_continue()
    {
        var api = new FakeApi();
        var o = await Reader(api).ReadAsync(CancellationToken.None);
        o.Pods.Should().HaveCount(3 * K8sReader.PageSize);
        o.PodsTruncated.Should().BeFalse();
        api.Seen.Select(s => s.Split('?')[0]).Distinct().Should().BeEquivalentTo(K8sReader.Paths);
        api.Seen.Should().OnlyContain(s => s.Contains("limit=500"));
        api.Seen.Should().NotContain(s => s.Contains("secret", StringComparison.OrdinalIgnoreCase) || s.Contains("configmap", StringComparison.OrdinalIgnoreCase));
        api.Seen.Count(s => s.StartsWith("/api/v1/pods", StringComparison.Ordinal)).Should().Be(3);
    }

    [Fact]
    public async Task Pods_are_capped_and_truncation_recorded()
    {
        var api = new FakeApi { PodPages = 8 };
        var o = await Reader(api).ReadAsync(CancellationToken.None);
        o.Pods.Should().HaveCount(K8sReader.MaxPods);
        o.PodsTruncated.Should().BeTrue();
        api.Seen.Count(s => s.StartsWith("/api/v1/pods", StringComparison.Ordinal)).Should().Be(K8sReader.MaxPods / K8sReader.PageSize);
    }

    [Fact]
    public async Task Optional_lists_degrade_and_required_ones_throw()
    {
        var api = new FakeApi { Override = p => p.Contains("networkpolicies") ? new HttpResponseMessage(HttpStatusCode.Forbidden) : null };
        var o = await Reader(api).ReadAsync(CancellationToken.None);
        o.NetworkPolicies.Should().BeEmpty();
        o.Warnings.Should().ContainSingle().Which.Should().Contain("networkpolicies not readable (HTTP 403)");

        var denied = new FakeApi { Override = p => p == "/api/v1/pods" ? new HttpResponseMessage(HttpStatusCode.Unauthorized) : null };
        var ex = await FluentActions.Awaiting(() => Reader(denied).ReadAsync(CancellationToken.None)).Should().ThrowAsync<K8sHttpException>();
        ex.Which.Status.Should().Be(401);
        K8sReader.IsAccessFailure(ex.Which).Should().BeTrue();
        K8sReader.DenialText(ex.Which, "role scan-role", true).Should().Be("EKS access entry for role scan-role (AmazonEKSViewPolicy)");
        K8sReader.DenialText(new K8sHttpException(403, "/api/v1/pods"), null, true).Should().Contain("AmazonEKSViewPolicy");
        K8sReader.DenialText(new HttpRequestException("x"), null, false).Should().Contain("private EKS API endpoint");
    }

    [Fact]
    public void Denied_collector_exception_classifies_as_denied_and_role_is_shortened()
    {
        ErrorClassifier.Classify(new CollectorDeniedException("EKS access entry for role r (AmazonEKSViewPolicy)"))
            .Should().Be((ErrorKind.Denied, "EKS access entry for role r (AmazonEKSViewPolicy)"));
        EksCollector.RoleOf("arn:aws:sts::111111111111:assumed-role/duplo-scan/session-1").Should().Be("role duplo-scan");
        EksCollector.RoleOf("arn:aws:iam::111111111111:user/alice").Should().Be("arn:aws:iam::111111111111:user/alice");
    }
}
