using System.Text.Json.Nodes;
using Amazon.EC2;
using Amazon.EC2.Model;
using Amazon.ElasticLoadBalancingV2;
using Amazon.Lambda.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.K8s;
using Ecs = Amazon.ECS.Model;
using V2 = Amazon.ElasticLoadBalancingV2.Model;

namespace Duplo.Extension.NetMap.Tests;

/// <summary>Workloads for the synthetic hub (v2b). Prod VPC (10.20.0.0/16): one EKS cluster "apps-eks" on node
/// i-node-1 whose ENI holds the pod IPs as secondary addresses; namespaces web (frontend ×3, api ×2, a NetworkPolicy,
/// an ingress behind the internet-facing ALB web-alb with ip targets, an internet-facing LoadBalancer service on
/// api-nlb), batch (worker ×14, no NetworkPolicy) and kube-system (coredns ×2). An ECS cluster "apps-ecs" with service
/// "orders" (2 tasks, one with a public IP) behind web-alb. In the egress VPC: Lambda "nightly-report" in a public
/// subnet (no internet for Lambda) and "audit-export" in a private subnet (via NAT). Invented ids only.</summary>
internal static class SyntheticWorkloads
{
    public const string Cluster = "apps-eks";
    public const string AlbArn = "arn:aws:elasticloadbalancing:us-east-1:222222222222:loadbalancer/app/web-alb/0a1b2c3d4e5f6a7b";
    public const string NlbArn = "arn:aws:elasticloadbalancing:us-east-1:222222222222:loadbalancer/net/api-nlb/1a2b3c4d5e6f7a8b";
    public const string WebTg = "arn:aws:elasticloadbalancing:us-east-1:222222222222:targetgroup/web-tg/aaaa1111bbbb2222";
    public const string OrdersTg = "arn:aws:elasticloadbalancing:us-east-1:222222222222:targetgroup/orders-tg/cccc3333dddd4444";
    public const string AlbDns = "web-alb-1234567890.us-east-1.elb.amazonaws.com";
    public const string NlbDns = "api-nlb-0987654321.elb.us-east-1.amazonaws.com";
    public const string EcsCluster = "arn:aws:ecs:us-east-1:222222222222:cluster/apps-ecs";
    public const string OrdersService = "arn:aws:ecs:us-east-1:222222222222:service/apps-ecs/orders";

    private static readonly string[] PodIps = Enumerable.Range(11, 30).Select(i => $"10.20.1.{i}").ToArray();

    public static InterfacesData ProdInterfaces() => new(
        Interfaces: new()
        {
            new NetworkInterface
            {
                NetworkInterfaceId = "eni-node-1", SubnetId = "subnet-prod-app-1a", VpcId = "vpc-prod", PrivateIpAddress = "10.20.1.10",
                PrivateIpAddresses = new[] { "10.20.1.10" }.Concat(PodIps).Select(ip => new NetworkInterfacePrivateIpAddress { PrivateIpAddress = ip }).ToList(),
                Attachment = new NetworkInterfaceAttachment { InstanceId = "i-node-1" }, Groups = new() { new GroupIdentifier { GroupId = "sg-eks-node" } },
                Description = "aws-K8S-i-node-1",
            },
            new NetworkInterface
            {
                NetworkInterfaceId = "eni-alb-web", SubnetId = "subnet-prod-app-1a", VpcId = "vpc-prod", PrivateIpAddress = "10.20.1.200",
                PrivateIpAddresses = new() { new NetworkInterfacePrivateIpAddress { PrivateIpAddress = "10.20.1.200" } },
                Description = "ELB app/web-alb/0a1b2c3d4e5f6a7b", RequesterManaged = true, Groups = new() { new GroupIdentifier { GroupId = "sg-alb" } },
            },
            Task("eni-orders-1", "10.20.1.50", "198.51.100.77"),
            Task("eni-orders-2", "10.20.1.51", null),
        },
        SecurityGroups: new()
        {
            new SecurityGroup { GroupId = "sg-eks-node", GroupName = "eks-node", VpcId = "vpc-prod" },
            new SecurityGroup { GroupId = "sg-alb", GroupName = "web-alb", VpcId = "vpc-prod" },
            new SecurityGroup { GroupId = "sg-orders", GroupName = "orders", VpcId = "vpc-prod" },
            new SecurityGroup { GroupId = "sg-eks-cluster", GroupName = "eks-cluster", VpcId = "vpc-prod" },
        },
        Rules: new()
        {
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-alb-in", GroupId = "sg-alb", IsEgress = false, IpProtocol = "tcp", FromPort = 443, ToPort = 443, CidrIpv4 = "10.0.0.0/8" },
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-alb-out", GroupId = "sg-alb", IsEgress = true, IpProtocol = "-1", FromPort = -1, ToPort = -1, CidrIpv4 = "10.20.1.0/24" },
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-node-in", GroupId = "sg-eks-node", IsEgress = false, IpProtocol = "tcp", FromPort = 8080, ToPort = 8080, ReferencedGroupInfo = new ReferencedSecurityGroup { GroupId = "sg-alb" } },
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-node-out", GroupId = "sg-eks-node", IsEgress = true, IpProtocol = "-1", FromPort = -1, ToPort = -1, CidrIpv4 = "0.0.0.0/0" },
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-orders-in", GroupId = "sg-orders", IsEgress = false, IpProtocol = "tcp", FromPort = 80, ToPort = 80, ReferencedGroupInfo = new ReferencedSecurityGroup { GroupId = "sg-alb" } },
        },
        Instances: new() { new Instance { InstanceId = "i-node-1", Tags = new() { new Tag("Name", "apps-eks-node-1") } } });

    private static NetworkInterface Task(string id, string ip, string? publicIp) => new()
    {
        NetworkInterfaceId = id, SubnetId = "subnet-prod-app-1a", VpcId = "vpc-prod", PrivateIpAddress = ip, RequesterManaged = true,
        PrivateIpAddresses = new() { new NetworkInterfacePrivateIpAddress { PrivateIpAddress = ip } },
        Description = "arn:aws:ecs:us-east-1:222222222222:attachment/" + id, Groups = new() { new GroupIdentifier { GroupId = "sg-orders" } },
        Association = publicIp == null ? null : new NetworkInterfaceAssociation { PublicIp = publicIp },
    };

    public static LoadBalancerData ProdLoadBalancers()
    {
        var target = (string ip, int port) => new V2.TargetHealthDescription
        {
            Target = new V2.TargetDescription { Id = ip, Port = port }, TargetHealth = new V2.TargetHealth { State = TargetHealthStateEnum.Healthy },
        };
        return new LoadBalancerData(
            LoadBalancers: new()
            {
                new V2.LoadBalancer { LoadBalancerArn = AlbArn, LoadBalancerName = "web-alb", DNSName = AlbDns, Scheme = LoadBalancerSchemeEnum.InternetFacing,
                    Type = LoadBalancerTypeEnum.Application, VpcId = "vpc-prod", SecurityGroups = new() { "sg-alb" },
                    AvailabilityZones = new() { new V2.AvailabilityZone { SubnetId = "subnet-prod-app-1a", ZoneName = "us-east-1a" } } },
                new V2.LoadBalancer { LoadBalancerArn = NlbArn, LoadBalancerName = "api-nlb", DNSName = NlbDns, Scheme = LoadBalancerSchemeEnum.InternetFacing,
                    Type = LoadBalancerTypeEnum.Network, VpcId = "vpc-prod",
                    AvailabilityZones = new() { new V2.AvailabilityZone { SubnetId = "subnet-prod-app-1a", ZoneName = "us-east-1a" } } },
            },
            Listeners: new()
            {
                new V2.Listener { LoadBalancerArn = AlbArn, Port = 443, Protocol = ProtocolEnum.HTTPS },
                new V2.Listener { LoadBalancerArn = NlbArn, Port = 443, Protocol = ProtocolEnum.TCP },
            },
            TargetGroups: new()
            {
                new V2.TargetGroup { TargetGroupArn = WebTg, TargetGroupName = "web-tg", Port = 8080, Protocol = ProtocolEnum.HTTP, LoadBalancerArns = new() { AlbArn } },
                new V2.TargetGroup { TargetGroupArn = OrdersTg, TargetGroupName = "orders-tg", Port = 80, Protocol = ProtocolEnum.HTTP, LoadBalancerArns = new() { AlbArn } },
            },
            TargetHealth: new()
            {
                [WebTg] = new() { target("10.20.1.11", 8080), target("10.20.1.12", 8080), target("10.20.1.13", 8080) },
                [OrdersTg] = new() { target("10.20.1.50", 80), target("10.20.1.51", 80) },
            },
            Tags: new(),
            Classic: new());
    }

    public static EksData ProdEks()
    {
        var pods = new List<K8sPod>();
        var ip = 0;
        K8sPod Pod(string ns, string owner, string hash, int i, string app) => new(ns, $"{owner}-{hash}-{i:x5}",
            new Dictionary<string, string> { ["app"] = app, ["pod-template-hash"] = hash }, PodIps[ip], new() { PodIps[ip++] }, "Running",
            "ip-10-20-1-10.ec2.internal", false, "Deployment", owner, new() { new K8sContainer(owner, $"registry.example.com/{owner}:1.0") });
        for (var i = 0; i < 3; i++) pods.Add(Pod("web", "frontend", "7d4b9c", i, "frontend"));
        for (var i = 0; i < 2; i++) pods.Add(Pod("web", "api", "5f6a7b", i, "api"));
        for (var i = 0; i < 2; i++) pods.Add(Pod("kube-system", "coredns", "6c7d8e", i, "kube-dns"));
        for (var i = 0; i < 14; i++) pods.Add(Pod("batch", "worker", "9a8b7c", i, "worker"));
        pods.Add(new K8sPod("batch", "report-28934520-zzzzz", new(), null, new(), "Succeeded", null, false, "Job", "report-28934520", new()));

        var objects = new K8sObjects
        {
            Namespaces = new() { new("web", new() { ["team"] = "shop" }), new("batch", new()), new("kube-system", new()) },
            Pods = pods,
            Services = new()
            {
                new("web", "frontend", "ClusterIP", "172.20.0.20", new() { ["app"] = "frontend" }, new() { new("http", "TCP", 80, "8080", null) }, new(), new(), new()),
                new("web", "api", "LoadBalancer", "172.20.0.21", new() { ["app"] = "api" }, new() { new("https", "TCP", 443, "8443", 31443) },
                    new() { NlbDns }, new(), new() { ["service.beta.kubernetes.io/aws-load-balancer-scheme"] = "internet-facing" }),
                new("kube-system", "kube-dns", "ClusterIP", "172.20.0.10", new() { ["app"] = "kube-dns" }, new() { new("dns", "UDP", 53, "53", null) }, new(), new(), new()),
            },
            Ingresses = new()
            {
                new("web", "frontend", "alb", new() { new K8sIngressRule("shop.example.com", "/", "frontend", "80") }, new() { AlbDns }, new(),
                    new() { ["alb.ingress.kubernetes.io/scheme"] = "internet-facing", ["alb.ingress.kubernetes.io/target-type"] = "ip" }),
            },
            NetworkPolicies = new()
            {
                new("web", "web-default", new JsonObject(), new() { "Ingress", "Egress" },
                    JsonNode.Parse("""[{"from":[{"ipBlock":{"cidr":"10.20.0.0/16","except":[]}}],"ports":[{"protocol":"TCP","port":8080}]}]""")!.AsArray(),
                    JsonNode.Parse("""[{"to":[{"ipBlock":{"cidr":"0.0.0.0/0","except":["169.254.169.254/32"]}}],"ports":[{"protocol":"TCP","port":443}]},{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}}}],"ports":[{"protocol":"UDP","port":53}]}]""")!.AsArray()),
            },
            Nodes = new() { new K8sNode("ip-10-20-1-10.ec2.internal", "i-node-1", "10.20.1.10") },
        };
        var info = new EksClusterInfo(Cluster, $"arn:aws:eks:us-east-1:222222222222:cluster/{Cluster}", "vpc-prod", "1.30", "ACTIVE", true, true,
            new() { "subnet-prod-app-1a" }, new(), "sg-eks-cluster", "API_AND_CONFIG_MAP");
        var denied = new EksClusterInfo("legacy-eks", null, "vpc-prod", "1.27", "ACTIVE", true, false, new(), new(), null, "CONFIG_MAP");
        return new EksData(new()
        {
            new EksClusterData(info, objects),
            new EksClusterData(denied, null, "EKS access entry for role scan-role (AmazonEKSViewPolicy)", AccessDenied: true),
        });
    }

    public static EcsData ProdEcs()
    {
        Ecs.Task T(string id, string eni, string subnet, string ip) => new()
        {
            TaskArn = $"arn:aws:ecs:us-east-1:222222222222:task/apps-ecs/{id}", Group = "service:orders", LastStatus = "RUNNING", DesiredStatus = "RUNNING",
            LaunchType = Amazon.ECS.LaunchType.FARGATE, TaskDefinitionArn = "arn:aws:ecs:us-east-1:222222222222:task-definition/orders:7",
            Containers = new() { new Ecs.Container { Name = "orders", Image = "registry.example.com/orders:2.1" } },
            Attachments = new() { new Ecs.Attachment { Type = "ElasticNetworkInterface", Details = new()
            {
                new Ecs.KeyValuePair { Name = "networkInterfaceId", Value = eni }, new Ecs.KeyValuePair { Name = "subnetId", Value = subnet },
                new Ecs.KeyValuePair { Name = "privateIPv4Address", Value = ip },
            } } },
        };
        return new EcsData(new()
        {
            new EcsClusterData(new Ecs.Cluster { ClusterArn = EcsCluster, ClusterName = "apps-ecs", Status = "ACTIVE" },
                new()
                {
                    new Ecs.Service
                    {
                        ServiceArn = OrdersService, ServiceName = "orders", Status = "ACTIVE", DesiredCount = 2, RunningCount = 2, LaunchType = Amazon.ECS.LaunchType.FARGATE,
                        TaskDefinition = "arn:aws:ecs:us-east-1:222222222222:task-definition/orders:7",
                        NetworkConfiguration = new Ecs.NetworkConfiguration { AwsvpcConfiguration = new Ecs.AwsVpcConfiguration
                            { Subnets = new() { "subnet-prod-app-1a" }, SecurityGroups = new() { "sg-orders" }, AssignPublicIp = Amazon.ECS.AssignPublicIp.ENABLED } },
                        LoadBalancers = new() { new Ecs.LoadBalancer { TargetGroupArn = OrdersTg, ContainerName = "orders", ContainerPort = 80 } },
                    },
                },
                new()
                {
                    T("0123456789abcdef0", "eni-orders-1", "subnet-prod-app-1a", "10.20.1.50"),
                    T("1123456789abcdef0", "eni-orders-2", "subnet-prod-app-1a", "10.20.1.51"),
                    T("2223456789abcdef0", "eni-elsewhere", "subnet-not-a-member", "10.99.0.5"),
                }, false),
            new EcsClusterData(new Ecs.Cluster { ClusterArn = "arn:aws:ecs:us-east-1:222222222222:cluster/other", ClusterName = "other", Status = "ACTIVE" }, new(), new(), false),
        });
    }

    public static IEnumerable<NetworkInterface> NetLambdaInterfaces() => new[]
    {
        new NetworkInterface
        {
            NetworkInterfaceId = "eni-lambda-report", SubnetId = "subnet-egress-pub-1a", VpcId = "vpc-egress", PrivateIpAddress = "10.100.101.60",
            PrivateIpAddresses = new() { new NetworkInterfacePrivateIpAddress { PrivateIpAddress = "10.100.101.60" } }, RequesterManaged = true,
            InterfaceType = NetworkInterfaceType.Lambda, Groups = new() { new GroupIdentifier { GroupId = "sg-lambda" } },
            Description = "AWS Lambda VPC ENI-nightly-report-0f0e0d0c-1111-2222-3333-444455556666",
        },
        new NetworkInterface
        {
            NetworkInterfaceId = "eni-lambda-shared", SubnetId = "subnet-egress-priv-1a", VpcId = "vpc-egress", PrivateIpAddress = "10.100.1.60",
            PrivateIpAddresses = new() { new NetworkInterfacePrivateIpAddress { PrivateIpAddress = "10.100.1.60" } }, RequesterManaged = true,
            InterfaceType = NetworkInterfaceType.Lambda, Groups = new() { new GroupIdentifier { GroupId = "sg-lambda" } },
            Description = "AWS Lambda VPC ENI-some-other-fn-0f0e0d0c-1111-2222-3333-777788889999",
        },
    };

    public static LambdaData NetLambda() => new(new()
    {
        new FunctionConfiguration { FunctionName = "nightly-report", FunctionArn = "arn:aws:lambda:us-east-1:111111111111:function:nightly-report", Runtime = "python3.12",
            State = "Active", VpcConfig = new VpcConfigDetail { VpcId = "vpc-egress", SubnetIds = new() { "subnet-egress-pub-1a" }, SecurityGroupIds = new() { "sg-lambda" } } },
        new FunctionConfiguration { FunctionName = "audit-export", FunctionArn = "arn:aws:lambda:us-east-1:111111111111:function:audit-export", Runtime = "nodejs20.x",
            State = "Active", VpcConfig = new VpcConfigDetail { VpcId = "vpc-egress", SubnetIds = new() { "subnet-egress-priv-1a" }, SecurityGroupIds = new() { "sg-lambda" } } },
        new FunctionConfiguration { FunctionName = "not-in-vpc", FunctionArn = "arn:aws:lambda:us-east-1:111111111111:function:not-in-vpc", Runtime = "python3.12" },
        new FunctionConfiguration { FunctionName = "other-vpc", FunctionArn = "arn:aws:lambda:us-east-1:111111111111:function:other-vpc",
            VpcConfig = new VpcConfigDetail { VpcId = "vpc-elsewhere", SubnetIds = new() { "subnet-x" } } },
    });
}
