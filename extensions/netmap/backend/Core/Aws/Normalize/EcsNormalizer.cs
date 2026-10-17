using System.Text.Json.Nodes;
using Amazon.ECS.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using EcsTask = Amazon.ECS.Model.Task;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record EcsClusterData(Cluster Cluster, List<Service> Services, List<EcsTask> Tasks, bool TasksTruncated);

public sealed record EcsData(List<EcsClusterData> Clusters);

/// <summary>ECS clusters / services / tasks that use awsvpc networking in member networks. Tasks without an ENI in a
/// member subnet (bridge/host mode, other VPCs) are skipped. A cluster sits under its network when all its kept
/// services and tasks are in one network, else under the account. Links: service runs task, task runs-on its ENI,
/// service uses its security groups, load balancer exposes service (by target group) and task (ip target).
/// No raw: task definitions (env, secrets) are never read.</summary>
public static class EcsNormalizer
{
    public static readonly string Collector = Collectors.Ecs.Id;

    public static GraphPart Normalize(CollectorContext ctx, EcsData d)
    {
        var b = ctx.Builder(Collector);
        var links = new WorkloadLinks(ctx);
        var members = ctx.MemberVpcIds.Select(v => ctx.NetworkId(v)).ToHashSet(StringComparer.Ordinal);
        var subnetNet = ctx.PriorNodes(NodeKinds.Subnet).Where(s => s.ParentId != null && members.Contains(s.ParentId))
            .ToDictionary(s => s.NativeId, s => s.ParentId!, StringComparer.Ordinal);
        var lbByTg = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var lb in links.LoadBalancers)
            foreach (var tg in lb.AttrStrings("targetGroupArns")) lbByTg.TryAdd(tg, lb.Id);
        var warnings = new List<string>();

        foreach (var c in d.Clusters)
        {
            var services = c.Services.Select(s => (Svc: s, Subnets: Aws.L(s.NetworkConfiguration?.AwsvpcConfiguration?.Subnets)))
                .Where(x => x.Subnets.Any(subnetNet.ContainsKey)).ToList();
            var tasks = c.Tasks.Select(t => (Task: t, Eni: TaskEni(t))).Where(x => x.Eni.Subnet != null && subnetNet.ContainsKey(x.Eni.Subnet)).ToList();
            if (services.Count == 0 && tasks.Count == 0) continue;

            var nets = services.SelectMany(s => s.Subnets).Concat(tasks.Select(t => t.Eni.Subnet!))
                .Where(subnetNet.ContainsKey).Select(s => subnetNet[s]).Distinct(StringComparer.Ordinal).ToList();
            var cluster = b.Node(ctx.Id(NodeKinds.EcsCluster, c.Cluster.ClusterArn), NodeKinds.EcsCluster, c.Cluster.ClusterArn, ctx.Account, ctx.Region)
                .Named(c.Cluster.ClusterName).Under(nets.Count == 1 ? nets[0] : ctx.AccountId(null)).SetState(c.Cluster.Status?.ToLowerInvariant())
                .Attr("serviceCount", services.Count).Attr("taskCount", tasks.Count).Attr("tasksTruncated", c.TasksTruncated ? true : null)
                .Attr("networks", NodeExtensions.Arr(nets));
            if (c.TasksTruncated) warnings.Add($"ECS cluster {c.Cluster.ClusterName}: tasks truncated at 2000");

            var serviceIds = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (s, subnets) in services)
            {
                var vpc = s.NetworkConfiguration!.AwsvpcConfiguration!;
                var n = b.Node(ctx.Id(NodeKinds.EcsService, s.ServiceArn), NodeKinds.EcsService, s.ServiceArn, ctx.Account, ctx.Region)
                    .Named(s.ServiceName).Under(cluster.Id).SetState(s.Status?.ToLowerInvariant())
                    .Attr("cluster", c.Cluster.ClusterName).Attr("launchType", s.LaunchType?.Value ?? (Aws.L(s.CapacityProviderStrategy).Count > 0 ? "capacity-provider" : null))
                    .Attr("desiredCount", s.DesiredCount).Attr("runningCount", s.RunningCount)
                    .Attr("taskDefinition", ShortTaskDef(s.TaskDefinition)).Attr("subnets", NodeExtensions.Arr(subnets))
                    .Attr("securityGroups", NodeExtensions.Arr(Aws.L(vpc.SecurityGroups))).Attr("assignPublicIp", vpc.AssignPublicIp?.Value)
                    .Attr("loadBalancers", new JsonArray(Aws.L(s.LoadBalancers).Select(l => (JsonNode?)new JsonObject
                    {
                        ["targetGroupArn"] = l.TargetGroupArn, ["loadBalancerName"] = l.LoadBalancerName,
                        ["containerName"] = l.ContainerName, ["containerPort"] = l.ContainerPort,
                    }).ToArray()));
                serviceIds[s.ServiceName] = n.Id;
                foreach (var sg in Aws.L(vpc.SecurityGroups)) b.Edge(n.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.SecurityGroup, sg));
                foreach (var l in Aws.L(s.LoadBalancers))
                    if (l.TargetGroupArn != null && lbByTg.TryGetValue(l.TargetGroupArn, out var lbId))
                        b.Edge(lbId, EdgeKinds.Exposes, n.Id, l.TargetGroupArn).Attr("targetGroup", l.TargetGroupArn.Split('/').ElementAtOrDefault(1))
                            .Attr("port", l.ContainerPort).Attr("container", l.ContainerName);
            }

            var taskByIp = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (t, eni) in tasks)
            {
                var shortId = t.TaskArn.Split('/').Last();
                var group = t.Group ?? "";
                var svcName = group.StartsWith("service:", StringComparison.Ordinal) ? group["service:".Length..] : null;
                var eniId = eni.EniId != null ? ctx.Id(NodeKinds.NetworkInterface, eni.EniId) : null;
                var publicIp = eniId != null ? links.Eni(eniId)?.AttrString("publicIp") : null;
                var n = b.Node(ctx.Id(NodeKinds.EcsTask, t.TaskArn), NodeKinds.EcsTask, t.TaskArn, ctx.Account, ctx.Region)
                    .Named($"{svcName ?? ShortTaskDef(t.TaskDefinitionArn)?.Split(':')[0] ?? "task"}/{shortId[..Math.Min(8, shortId.Length)]}")
                    .Under(cluster.Id).SetState(t.LastStatus?.ToLowerInvariant())
                    .Attr("cluster", c.Cluster.ClusterName).Attr("service", svcName).Attr("group", t.Group).Attr("lastStatus", t.LastStatus)
                    .Attr("desiredStatus", t.DesiredStatus).Attr("launchType", t.LaunchType?.Value).Attr("taskDefinition", ShortTaskDef(t.TaskDefinitionArn))
                    .Attr("privateIp", eni.Ip).Attr("eniId", eni.EniId).Attr("subnetId", eni.Subnet).Attr("publicIp", publicIp)
                    .Attr("az", t.AvailabilityZone)
                    .Attr("containers", WorkloadLinks.Containers(Aws.L(t.Containers).Select(x => (x.Name ?? "", x.Image ?? ""))))
                    .Attr("images", NodeExtensions.Arr(Aws.L(t.Containers).Select(x => x.Image).Distinct()));
                if (eniId != null) b.Edge(n.Id, EdgeKinds.RunsOn, eniId).Attr("ip", eni.Ip);
                if (svcName != null && serviceIds.TryGetValue(svcName, out var sid)) b.Edge(sid, EdgeKinds.Runs, n.Id);
                if (eni.Ip != null) taskByIp.TryAdd(eni.Ip, n.Id);
            }
            links.Exposes(b, taskByIp);
        }

        var part = b.Build();
        part.Warnings.AddRange(warnings);
        return part;
    }

    /// <summary>The task's awsvpc ENI: id, subnet and private IP from its ElasticNetworkInterface attachment.</summary>
    public static (string? EniId, string? Subnet, string? Ip) TaskEni(EcsTask t)
    {
        var att = Aws.L(t.Attachments).FirstOrDefault(a => a.Type == "ElasticNetworkInterface");
        string? Detail(string name) => Aws.L(att?.Details).FirstOrDefault(x => x.Name == name)?.Value;
        return (Detail("networkInterfaceId"), Detail("subnetId"), Detail("privateIPv4Address"));
    }

    /// <summary>"arn:…:task-definition/web:12" → "web:12".</summary>
    public static string? ShortTaskDef(string? arn) => arn?.Split('/').Last();
}
