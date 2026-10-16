using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class InterfacesNormalizerTests
{
    private static InterfacesData Data() => new(
        Interfaces: new()
        {
            new NetworkInterface { NetworkInterfaceId = "eni-web", SubnetId = "subnet-1", VpcId = "vpc-1", PrivateIpAddress = "10.0.1.10",
                PrivateIpAddresses = new() { new NetworkInterfacePrivateIpAddress { PrivateIpAddress = "10.0.1.10" }, new NetworkInterfacePrivateIpAddress { PrivateIpAddress = "10.0.1.11" } },
                Attachment = new NetworkInterfaceAttachment { InstanceId = "i-web" }, Groups = new() { new GroupIdentifier { GroupId = "sg-web" } },
                Association = new NetworkInterfaceAssociation { PublicIp = "203.0.113.20" }, InterfaceType = NetworkInterfaceType.Interface },
            new NetworkInterface { NetworkInterfaceId = "eni-fn", SubnetId = "subnet-1", VpcId = "vpc-1", InterfaceType = NetworkInterfaceType.Lambda,
                Description = "AWS Lambda VPC ENI-payments-api-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", RequesterManaged = true, Groups = new() { new GroupIdentifier { GroupId = "sg-app" } } },
            new NetworkInterface { NetworkInterfaceId = "eni-nlb", SubnetId = "subnet-1", VpcId = "vpc-1", Description = "ELB net/internal-api/50dc6c495c0c9188", RequesterManaged = true },
        },
        SecurityGroups: new()
        {
            new SecurityGroup { GroupId = "sg-web", GroupName = "web-sg", VpcId = "vpc-1" },
            new SecurityGroup { GroupId = "sg-app", GroupName = "app-sg", VpcId = "vpc-1" },
        },
        Rules: new()
        {
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-1", GroupId = "sg-web", IsEgress = false, IpProtocol = "tcp", FromPort = 443, ToPort = 443, CidrIpv4 = "0.0.0.0/0" },
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-2", GroupId = "sg-web", IsEgress = true, IpProtocol = "-1", FromPort = -1, ToPort = -1, CidrIpv6 = "::/0" },
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-3", GroupId = "sg-app", IsEgress = false, IpProtocol = "tcp", FromPort = 8080, ToPort = 8080, ReferencedGroupInfo = new ReferencedSecurityGroup { GroupId = "sg-web" } },
            new SecurityGroupRule { SecurityGroupRuleId = "sgr-4", GroupId = "sg-app", IsEgress = false, IpProtocol = "tcp", FromPort = 5432, ToPort = 5432, CidrIpv4 = "10.20.0.0/16" },
        },
        Instances: new() { new Instance { InstanceId = "i-web", Tags = new() { new Tag("Name", "web-1") }, InstanceType = InstanceType.T3Micro } });

    [Fact]
    public void Eni_is_placed_in_its_subnet_with_ips_groups_public_ip_and_workload()
    {
        var p = InterfacesNormalizer.Normalize(TestCtx.Make(), Data());
        var eni = p.Node(NodeKinds.NetworkInterface, "eni-web");
        eni.AttrString("vpcId").Should().Be("vpc-1");
        eni.ParentId.Should().Be(TestCtx.Id(NodeKinds.Subnet, "subnet-1"));
        eni.AttrStrings("privateIps").Should().Equal("10.0.1.10", "10.0.1.11");
        eni.AttrString("managedBy").Should().Be("ec2");
        p.EdgesFrom(eni.Id, EdgeKinds.Uses).Single().To.Should().Be(TestCtx.Id(NodeKinds.SecurityGroup, "sg-web"));
        p.EdgesFrom(eni.Id, EdgeKinds.Associated).Single().To.Should().Be(TestCtx.Id(NodeKinds.PublicIp, "203.0.113.20"));

        var wl = p.Node(NodeKinds.Workload, "i-web");
        wl.Name.Should().Be("web-1");
        wl.ParentId.Should().Be(eni.ParentId);
        p.EdgesFrom(wl.Id, EdgeKinds.Attaches).Single().To.Should().Be(eni.Id);
    }

    [Fact]
    public void Managed_interfaces_are_labelled_by_owner()
    {
        var p = InterfacesNormalizer.Normalize(TestCtx.Make(), Data());
        var fn = p.Node(NodeKinds.NetworkInterface, "eni-fn");
        fn.AttrString("managedBy").Should().Be("lambda");
        fn.Name.Should().Be("Lambda payments-api");
        p.Node(NodeKinds.NetworkInterface, "eni-nlb").AttrString("managedBy").Should().Be("load-balancer");
    }

    [Fact]
    public void Rules_become_directional_allows_edges_to_internet_cidrs_and_groups()
    {
        var p = InterfacesNormalizer.Normalize(TestCtx.Make(), Data());
        var web = TestCtx.Id(NodeKinds.SecurityGroup, "sg-web");
        var app = TestCtx.Id(NodeKinds.SecurityGroup, "sg-app");

        var inbound = p.Edges.Single(e => e.Kind == EdgeKinds.Allows && e.To == web);
        inbound.From.Should().Be(NodeId.Internet);
        inbound.AttrString("direction").Should().Be("ingress");
        inbound.AttrString("protocol").Should().Be("tcp");

        var outbound = p.Edges.Single(e => e.Kind == EdgeKinds.Allows && e.From == web && e.To == NodeId.Internet);
        outbound.AttrString("direction").Should().Be("egress");
        outbound.AttrString("protocol").Should().Be("all");

        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Allows && e.From == web && e.To == app);
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Allows && e.From == NodeId.Cidr("10.20.0.0/16") && e.To == app);
        p.Nodes.Should().Contain(n => n.Id == NodeId.Internet && n.Kind == NodeKinds.External);
        p.Nodes.Single(n => n.Id == NodeId.Cidr("10.20.0.0/16")).Cidrs.Should().Equal("10.20.0.0/16");
        p.Node(NodeKinds.SecurityGroup, "sg-web").Name.Should().Be("web-sg");
    }

    [Fact]
    public void Workload_is_parented_in_the_instance_subnet_regardless_of_eni_order()
    {
        NetworkInterface Eni(string id, string subnet) => new() { NetworkInterfaceId = id, SubnetId = subnet, VpcId = "vpc-1", Attachment = new NetworkInterfaceAttachment { InstanceId = "i-multi" } };
        var d = new InterfacesData(new() { Eni("eni-a", "subnet-1"), Eni("eni-b", "subnet-2") }, new(), new(),
            new() { new Instance { InstanceId = "i-multi", SubnetId = "subnet-2" } });
        var p = InterfacesNormalizer.Normalize(TestCtx.Make(), d);
        p.Node(NodeKinds.Workload, "i-multi").ParentId.Should().Be(TestCtx.Id(NodeKinds.Subnet, "subnet-2"));
    }

    [Fact]
    public void Prefix_list_rules_are_tagged_and_peer_marked_unresolved()
    {
        var d = new InterfacesData(new(), new() { new SecurityGroup { GroupId = "sg-web", GroupName = "web-sg", VpcId = "vpc-1" } },
            new() { new SecurityGroupRule { SecurityGroupRuleId = "sgr-pl", GroupId = "sg-web", IsEgress = false, IpProtocol = "tcp", FromPort = 443, ToPort = 443, PrefixListId = "pl-1" } }, new());
        var p = InterfacesNormalizer.Normalize(TestCtx.Make(), d);
        var e = p.Edges.Single(x => x.Kind == EdgeKinds.Allows);
        e.AttrString("prefixListId").Should().Be("pl-1");
        p.Nodes.Single(n => n.Id == e.From).AttrBool("unresolved").Should().BeTrue();
    }
}
