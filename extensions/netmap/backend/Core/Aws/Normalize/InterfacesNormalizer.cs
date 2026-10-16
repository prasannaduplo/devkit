using System.Text.RegularExpressions;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record InterfacesData(List<NetworkInterface> Interfaces, List<SecurityGroup> SecurityGroups, List<SecurityGroupRule> Rules, List<Instance> Instances);

/// <summary>ENIs (placed in their subnet, all private IPs, public IP, managed-by label), EC2 workloads, security
/// groups, and every SG rule as a directional "allows" edge to the internet, a CIDR block or a referenced group.
/// Workload identity for Lambda/ECS/EKS beyond the ENI label is v2.</summary>
public static class InterfacesNormalizer
{
    public static readonly string Collector = Collectors.Interfaces.Id;

    private static readonly Regex LambdaName = new(
        @"^AWS Lambda VPC ENI-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.Compiled);

    public static GraphPart Normalize(CollectorContext ctx, InterfacesData d)
    {
        var b = ctx.Builder(Collector);
        var instances = d.Instances.Where(i => i.InstanceId != null).ToDictionary(i => i.InstanceId, StringComparer.Ordinal);

        foreach (var sg in d.SecurityGroups)
        {
            var n = b.Node(ctx.Id(NodeKinds.SecurityGroup, sg.GroupId), NodeKinds.SecurityGroup, sg.GroupId, sg.OwnerId ?? ctx.Account, ctx.Region)
                .Named(sg.GroupName).Tagged(Aws.Tags(sg.Tags)).Under(ctx.NetworkId(sg.VpcId)).Attr("description", sg.Description);
            n.Raw = RawJson.From(sg);
        }

        foreach (var eni in d.Interfaces)
        {
            var (managedBy, label) = Classify(eni);
            var n = b.Node(ctx.Id(NodeKinds.NetworkInterface, eni.NetworkInterfaceId), NodeKinds.NetworkInterface, eni.NetworkInterfaceId, eni.OwnerId ?? ctx.Account, ctx.Region)
                .Named(label).Tagged(Aws.Tags(eni.TagSet)).Under(ctx.Id(NodeKinds.Subnet, eni.SubnetId)).SetState(eni.Status?.Value)
                .Attr("vpcId", eni.VpcId).Attr("interfaceType", eni.InterfaceType?.Value).Attr("requesterId", eni.RequesterId)
                .Attr("requesterManaged", eni.RequesterManaged ?? false).Attr("description", eni.Description)
                .Attr("managedBy", managedBy).Attr("az", eni.AvailabilityZone).Attr("privateIp", eni.PrivateIpAddress)
                .Attr("privateIps", NodeExtensions.Arr(Aws.L(eni.PrivateIpAddresses).Select(p => p.PrivateIpAddress)))
                .Attr("publicIp", eni.Association?.PublicIp);
            n.Raw = RawJson.From(eni);

            foreach (var g in Aws.L(eni.Groups).Where(g => g.GroupId != null))
                b.Edge(n.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.SecurityGroup, g.GroupId));

            if (eni.Association?.PublicIp is { } ip)
            {
                var native = eni.Association.AllocationId ?? ip;
                var pip = b.Node(ctx.Id(NodeKinds.PublicIp, native), NodeKinds.PublicIp, native, ctx.Account, ctx.Region)
                    .Named(ip).Under(n.ParentId).Attr("ip", ip).Attr("elastic", eni.Association.AllocationId != null);
                b.Edge(n.Id, EdgeKinds.Associated, pip.Id);
            }

            if (eni.Attachment?.InstanceId is { } iid && instances.TryGetValue(iid, out var inst))
            {
                var w = b.Node(ctx.Id(NodeKinds.Workload, iid), NodeKinds.Workload, iid, ctx.Account, ctx.Region)
                    .Tagged(Aws.Tags(inst.Tags)).SetState(inst.State?.Name?.Value)
                    .Attr("workloadType", "ec2").Attr("instanceType", inst.InstanceType?.Value);
                w.ParentId ??= inst.SubnetId != null ? ctx.Id(NodeKinds.Subnet, inst.SubnetId) : n.ParentId;
                w.Raw ??= RawJson.From(inst);
                b.Edge(w.Id, EdgeKinds.Attaches, n.Id);
            }
        }

        EnsureInternet(b);
        foreach (var rule in d.Rules.Where(r => r.GroupId != null))
        {
            var sgId = ctx.Id(NodeKinds.SecurityGroup, rule.GroupId);
            string peer;
            var fromPrefixList = false;
            if (rule.ReferencedGroupInfo?.GroupId is { } refSg) peer = ctx.Id(NodeKinds.SecurityGroup, refSg);
            else if (rule.CidrIpv4 == "0.0.0.0/0" || rule.CidrIpv6 == "::/0") peer = NodeId.Internet;
            else if ((rule.CidrIpv4 ?? rule.CidrIpv6 ?? rule.PrefixListId) is { } cidr) { peer = EnsureCidr(b, cidr); fromPrefixList = rule.CidrIpv4 == null && rule.CidrIpv6 == null; }
            else continue;

            if (fromPrefixList) b.Node(peer, NodeKinds.CidrBlock, rule.PrefixListId, null, "global", "net").Attr("unresolved", true);
            var egress = rule.IsEgress == true;
            (egress ? b.Edge(sgId, EdgeKinds.Allows, peer, rule.SecurityGroupRuleId) : b.Edge(peer, EdgeKinds.Allows, sgId, rule.SecurityGroupRuleId))
                .Attr("direction", egress ? "egress" : "ingress")
                .Attr("protocol", rule.IpProtocol == "-1" ? "all" : rule.IpProtocol)
                .Attr("fromPort", rule.FromPort).Attr("toPort", rule.ToPort).Attr("description", rule.Description).Attr("prefixListId", rule.PrefixListId);
        }

        return b.Build();
    }

    internal static void EnsureInternet(PartBuilder b) =>
        b.Node(NodeId.Internet, NodeKinds.External, "internet", null, "global", "net").Named("Internet").Attr("role", "internet");

    internal static string EnsureCidr(PartBuilder b, string cidr)
    {
        var n = b.Node(NodeId.Cidr(cidr), NodeKinds.CidrBlock, cidr, null, "global", "net");
        if (!cidr.StartsWith("pl-", StringComparison.Ordinal) && !n.Cidrs.Contains(cidr)) n.Cidrs.Add(cidr);
        return n.Id;
    }

    internal static (string? ManagedBy, string? Label) Classify(NetworkInterface eni)
    {
        var desc = eni.Description ?? "";
        var type = eni.InterfaceType?.Value ?? "";
        if (eni.Attachment?.InstanceId != null && eni.RequesterManaged != true) return ("ec2", null);
        if (type == "lambda" || desc.StartsWith("AWS Lambda VPC ENI-", StringComparison.Ordinal))
        {
            var m = LambdaName.Match(desc);
            return ("lambda", "Lambda " + (m.Success ? m.Groups[1].Value : desc));
        }
        if (type == "nat_gateway" || desc.StartsWith("Interface for NAT Gateway", StringComparison.Ordinal)) return ("nat-gateway", desc);
        if (desc.StartsWith("ELB ", StringComparison.Ordinal)) return ("load-balancer", desc);
        if (type is "vpc_endpoint" or "gateway_load_balancer_endpoint") return ("vpc-endpoint", desc);
        if (type == "transit_gateway") return ("transit-gateway", desc);
        if (desc.StartsWith("Amazon EKS", StringComparison.Ordinal)) return ("eks", desc);
        if (desc.StartsWith("arn:aws:ecs:", StringComparison.Ordinal) || type == "branch") return ("ecs", desc);
        if (eni.RequesterId == "amazon-rds" || desc.StartsWith("RDSNetworkInterface", StringComparison.Ordinal)) return ("rds", "RDS " + eni.NetworkInterfaceId);
        if (eni.Attachment?.InstanceId != null) return ("ec2", null);
        return (null, string.IsNullOrEmpty(desc) ? null : desc);
    }
}
