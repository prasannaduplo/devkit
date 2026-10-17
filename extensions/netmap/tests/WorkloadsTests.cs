using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class WorkloadsTests
{
    private static FinalizeOutput Run(List<WorkUnit>? units = null) => SnapshotFinalizer.Finalize(new FinalizeInput(
        SyntheticHub.Members, units ?? SyntheticHub.BuildUnits(), SyntheticHub.Accounts, SyntheticHub.ScopeNames, TestCtx.Now));

    private static string Id(string kind, string native) => AwsIds.Of(SyntheticHub.Region, kind, native);

    private static GraphNode N(NetworkGraph g, string kind, string native) => g.Nodes.Single(n => n.Id == Id(kind, native));

    private static IEnumerable<GraphEdge> Out(NetworkGraph g, string from, string kind) => g.Edges.Where(e => e.From == from && e.Kind == kind);

    [Fact]
    public void Eks_cluster_namespaces_pods_and_links()
    {
        var g = Run().Graph;
        var cluster = N(g, NodeKinds.K8sCluster, "apps-eks");
        cluster.ParentId.Should().Be(Id(NodeKinds.Network, "vpc-prod"));
        cluster.AttrBool("readable").Should().BeTrue();
        N(g, NodeKinds.K8sCluster, "legacy-eks").AttrString("unreadableReason").Should().Contain("access entry");

        var web = N(g, NodeKinds.K8sNamespace, "apps-eks/web");
        web.ParentId.Should().Be(cluster.Id);
        g.Nodes.Where(n => n.Kind == NodeKinds.Pod).Should().HaveCount(21, "the Succeeded job pod is skipped");

        var pod = g.Nodes.Single(n => n.Kind == NodeKinds.Pod && n.Name == "frontend-7d4b9c-00000");
        pod.ParentId.Should().Be(web.Id);
        pod.Raw.Should().BeNull();
        pod.AttrString("podIp").Should().Be("10.20.1.11");
        pod.AttrString("ownerName").Should().Be("frontend");
        pod.AttrStrings("images").Should().Equal("registry.example.com/frontend:1.0");
        Out(g, pod.Id, EdgeKinds.RunsOn).Single().To.Should().Be(Id(NodeKinds.NetworkInterface, "eni-node-1"));

        var frontend = N(g, NodeKinds.K8sService, "apps-eks/web/frontend");
        Out(g, frontend.Id, EdgeKinds.Selects).Should().HaveCount(3);
        var ingress = N(g, NodeKinds.Ingress, "apps-eks/web/frontend");
        Out(g, ingress.Id, EdgeKinds.Backs).Select(e => e.To).Should().BeEquivalentTo(frontend.Id, Id(NodeKinds.LoadBalancer, SyntheticWorkloads.AlbArn));
        ingress.AttrString("scheme").Should().Be("internet-facing");

        var api = N(g, NodeKinds.K8sService, "apps-eks/web/api");
        Out(g, api.Id, EdgeKinds.Backs).Single().To.Should().Be(Id(NodeKinds.LoadBalancer, SyntheticWorkloads.NlbArn));
        api.AttrString("scheme").Should().Be("internet-facing");

        var np = N(g, NodeKinds.NetworkPolicy, "apps-eks/web/web-default");
        Out(g, np.Id, EdgeKinds.Selects).Should().HaveCount(5, "an empty podSelector selects every pod in its namespace");

        var alb = Id(NodeKinds.LoadBalancer, SyntheticWorkloads.AlbArn);
        Out(g, alb, EdgeKinds.Exposes).Select(e => g.Nodes.First(n => n.Id == e.To).Name)
            .Should().Contain(new[] { "frontend-7d4b9c-00000", "frontend-7d4b9c-00001", "frontend-7d4b9c-00002" });
    }

    [Fact]
    public void Ecs_and_lambda_nodes_and_links()
    {
        var g = Run().Graph;
        var cluster = N(g, NodeKinds.EcsCluster, SyntheticWorkloads.EcsCluster);
        cluster.ParentId.Should().Be(Id(NodeKinds.Network, "vpc-prod"), "all its services and tasks are in one network");
        g.Nodes.Should().NotContain(n => n.Kind == NodeKinds.EcsCluster && n.Name == "other");
        var svc = N(g, NodeKinds.EcsService, SyntheticWorkloads.OrdersService);
        Out(g, svc.Id, EdgeKinds.Runs).Should().HaveCount(2, "the task outside member subnets is skipped");
        g.Edges.Should().Contain(e => e.Kind == EdgeKinds.Exposes && e.From == Id(NodeKinds.LoadBalancer, SyntheticWorkloads.AlbArn) && e.To == svc.Id);
        var task = g.Nodes.Single(n => n.Kind == NodeKinds.EcsTask && n.AttrString("privateIp") == "10.20.1.50");
        task.AttrString("publicIp").Should().Be("198.51.100.77");
        Out(g, task.Id, EdgeKinds.RunsOn).Single().To.Should().Be(Id(NodeKinds.NetworkInterface, "eni-orders-1"));

        var report = g.Nodes.Single(n => n.Kind == NodeKinds.LambdaFunction && n.Name == "nightly-report");
        report.ParentId.Should().Be(Id(NodeKinds.Network, "vpc-egress"));
        Out(g, report.Id, EdgeKinds.RunsOn).Single().To.Should().Be(Id(NodeKinds.NetworkInterface, "eni-lambda-report"));
        var audit = g.Nodes.Single(n => n.Kind == NodeKinds.LambdaFunction && n.Name == "audit-export");
        Out(g, audit.Id, EdgeKinds.RunsOn).Single().To.Should().Be(Id(NodeKinds.NetworkInterface, "eni-lambda-shared"), "shared Hyperplane ENI: same subnet and groups");
        g.Nodes.Should().NotContain(n => n.Kind == NodeKinds.LambdaFunction && (n.Name == "not-in-vpc" || n.Name == "other-vpc"));
    }

    [Fact]
    public void Workload_findings()
    {
        var f = Run().Graph.Findings;
        f.Should().ContainSingle(x => x.RuleId == "k8s-service-public-lb").Which.Message.Should().StartWith("web/api");
        f.Where(x => x.RuleId == "k8s-namespace-no-networkpolicy").Select(x => x.Message)
            .Should().HaveCount(2).And.Contain(m => m.StartsWith("apps-eks/batch")).And.Contain(m => m.StartsWith("apps-eks/kube-system"));
        f.Should().ContainSingle(x => x.RuleId == "ecs-task-public-ip").Which.Message.Should().Contain("198.51.100.77");
        var lambda = f.Should().ContainSingle(x => x.RuleId == "lambda-no-egress").Which;
        lambda.Message.Should().StartWith("nightly-report").And.Contain("internet gateway");
        lambda.Severity.Should().Be(Severities.Warn);
    }

    [Fact]
    public void Workloads_capability_is_partial_with_the_unreadable_cluster_named()
    {
        var cap = Run().Summary.Capabilities[CapabilityKeys.Workloads];
        cap.State.Should().Be(CapabilityStates.Partial);
        cap.Reason.Should().StartWith("1 of 2 cluster(s) readable").And.Contain("legacy-eks: needs EKS access entry");
        cap.Counts["pods"].Should().Be(21);
        cap.Counts["tasks"].Should().Be(2);
        cap.Counts["functions"].Should().Be(2);
    }

    [Fact]
    public void Workloads_capability_states_from_units()
    {
        var empty = new GraphIndex(new NetworkGraph());
        CapabilityEvaluator.Workloads(empty, Array.Empty<WorkUnit>()).State.Should().Be(CapabilityStates.None);
        var denied = new WorkUnit { Collector = Collectors.Eks.Id, ScopeId = "s", Region = "r", Status = UnitStatuses.Denied, MissingPermission = "c1: EKS access entry for role x (AmazonEKSViewPolicy)" };
        var st = CapabilityEvaluator.Workloads(empty, new[] { denied });
        st.State.Should().Be(CapabilityStates.NotReadable);
        st.Reason.Should().Contain("c1: EKS access entry");
    }

    [Fact]
    public void Synthetic_world_still_keeps_hub_findings_unique()
    {
        var o = Run();
        o.ScanStatus.Should().Be(ScanStatuses.Complete);
        o.Graph.Findings.Should().ContainSingle(x => x.RuleId == "NET-001");
    }
}
