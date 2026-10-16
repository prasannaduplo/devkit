using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Tests;

/// <summary>Synthetic hub-and-spoke network: 5 TGWs in 3 domains (domains A-C, hub), 10 site-to-site VPNs
/// (one with a tunnel down), a shared egress VPC with 2 NAT + IGW, a spoke VPC in a second account whose default
/// route goes to the hub, stub spokes, and two TGW peerings to a third account. Invented ids only.</summary>
internal static class SyntheticHub
{
    public const string NetScope = "scope-net", ProdScope = "scope-prod";
    public const string NetAccount = "111111111111", ProdAccount = "222222222222", PeerAccount = "333333333333";
    public const string Region = "us-east-1";

    public static readonly List<BlueprintMember> Members = new()
    {
        new() { ScopeId = NetScope, Region = Region, NetworkId = "vpc-egress" },
        new() { ScopeId = ProdScope, Region = Region, NetworkId = "vpc-prod" },
    };

    public static readonly Dictionary<string, string> Accounts = new() { [NetScope] = NetAccount, [ProdScope] = ProdAccount };
    public static readonly Dictionary<string, string> ScopeNames = new() { [NetScope] = "network-hub", [ProdScope] = "prod-apps" };

    private static readonly (string Tgw, string Name)[] Tgws =
    {
        ("tgw-egress", "hub-egress-tgw"), ("tgw-domain-a", "domain-a-tgw"), ("tgw-domain-b", "domain-b-tgw"),
        ("tgw-domain-c", "domain-c-tgw"), ("tgw-domain-c-nat", "domain-c-nat-tgw"),
    };

    private static readonly (string Id, string Name, string Tgw, bool Static, bool Degraded)[] Vpns =
    {
        ("vpn-site-a-prod", "Site A prod", "tgw-domain-a", false, false), ("vpn-site-a-test", "Site A test", "tgw-domain-a", false, false),
        ("vpn-site-b", "Site B", "tgw-domain-a", false, false), ("vpn-site-c", "Site C", "tgw-domain-a", false, false),
        ("vpn-site-d-east", "Site D east", "tgw-domain-b", false, false), ("vpn-site-d-west", "Site D west", "tgw-domain-b", false, false),
        ("vpn-site-e-1", "Site E 1", "tgw-domain-c", true, false), ("vpn-site-e-2", "Site E 2", "tgw-domain-c", true, true),
        ("vpn-site-f-1", "Site F 1", "tgw-domain-c", true, false), ("vpn-site-f-2", "Site F 2", "tgw-domain-c", true, false),
    };

    private static List<Tag> Name(string n) => new() { new Tag("Name", n) };

    public static List<WorkUnit> BuildUnits()
    {
        var net = new CollectorContext(NetScope, NetAccount, Region, new[] { "vpc-egress" }, Members.Where(m => m.ScopeId == NetScope).ToList(), new List<GraphPart>(), TestCtx.Now);
        var prod = new CollectorContext(ProdScope, ProdAccount, Region, new[] { "vpc-prod" }, Members.Where(m => m.ScopeId == ProdScope).ToList(), new List<GraphPart>(), TestCtx.Now);

        var parts = new Dictionary<string, GraphPart>
        {
            [$"{Collectors.CoreNetwork.Id}|{NetScope}|{Region}"] = CoreNetworkNormalizer.Normalize(net, NetCore()),
            [$"{Collectors.Interfaces.Id}|{NetScope}|{Region}"] = InterfacesNormalizer.Normalize(net, NetInterfaces()),
            [$"{Collectors.Transit.Id}|{NetScope}|{Region}"] = TransitNormalizer.Normalize(net, NetTransit()),
            [$"{Collectors.CoreNetwork.Id}|{ProdScope}|{Region}"] = CoreNetworkNormalizer.Normalize(prod, ProdCore()),
            [$"{Collectors.Transit.Id}|{ProdScope}|{Region}"] = TransitNormalizer.Normalize(prod, ProdTransit()),
        };
        var netWithTransit = net with { Priors = new[] { parts[$"{Collectors.Transit.Id}|{NetScope}|{Region}"] } };
        parts[$"{Collectors.Vpn.Id}|{NetScope}|{Region}"] = VpnNormalizer.Normalize(netWithTransit, NetVpn());

        var units = ScanPlanner.Plan(Members, Collectors.All);
        foreach (var u in units)
        {
            u.Status = UnitStatuses.Done;
            u.Part = GraphCodec.Encode(parts.GetValueOrDefault(u.Id) ?? new GraphPart());
        }
        return units;
    }

    private static CoreNetworkData NetCore() => new(
        Vpcs: new() { new Vpc { VpcId = "vpc-egress", OwnerId = NetAccount, CidrBlock = "10.100.0.0/16", State = VpcState.Available, Tags = Name("egress") } },
        Subnets: new()
        {
            Sub("subnet-egress-priv-1a", "vpc-egress", "10.100.1.0/24", "us-east-1a", "private-1a"),
            Sub("subnet-egress-priv-1b", "vpc-egress", "10.100.2.0/24", "us-east-1b", "private-1b"),
            Sub("subnet-egress-pub-1a", "vpc-egress", "10.100.101.0/24", "us-east-1a", "public-1a"),
            Sub("subnet-egress-pub-1b", "vpc-egress", "10.100.102.0/24", "us-east-1b", "public-1b"),
        },
        RouteTables: new()
        {
            Rt("rtb-egress-priv", "vpc-egress", new[] { "subnet-egress-priv-1a", "subnet-egress-priv-1b" },
                new Route { DestinationCidrBlock = "0.0.0.0/0", NatGatewayId = "nat-egress-1a", State = RouteState.Active },
                new Route { DestinationCidrBlock = "10.0.0.0/8", TransitGatewayId = "tgw-egress", State = RouteState.Active }),
            Rt("rtb-egress-pub", "vpc-egress", new[] { "subnet-egress-pub-1a", "subnet-egress-pub-1b" },
                new Route { DestinationCidrBlock = "0.0.0.0/0", GatewayId = "igw-egress", State = RouteState.Active }),
        },
        NetworkAcls: new(),
        InternetGateways: new() { new InternetGateway { InternetGatewayId = "igw-egress", Attachments = new() { new InternetGatewayAttachment { VpcId = "vpc-egress", State = AttachmentStatus.Attached } } } },
        EgressOnlyGateways: new(),
        NatGateways: new()
        {
            Nat("nat-egress-1a", "subnet-egress-pub-1a", "203.0.113.10", "eipalloc-egress-1a"),
            Nat("nat-egress-1b", "subnet-egress-pub-1b", "203.0.113.11", "eipalloc-egress-1b"),
        },
        PrefixLists: new());

    private static InterfacesData NetInterfaces() => new(
        Interfaces: new() { new NetworkInterface { NetworkInterfaceId = "eni-bastion", SubnetId = "subnet-egress-pub-1a", VpcId = "vpc-egress",
            PrivateIpAddress = "10.100.101.20", Attachment = new NetworkInterfaceAttachment { InstanceId = "i-bastion" }, Groups = new() { new GroupIdentifier { GroupId = "sg-bastion" } } } },
        SecurityGroups: new() { new SecurityGroup { GroupId = "sg-bastion", GroupName = "bastion", VpcId = "vpc-egress" } },
        Rules: new() { new SecurityGroupRule { SecurityGroupRuleId = "sgr-ssh", GroupId = "sg-bastion", IsEgress = false, IpProtocol = "tcp", FromPort = 22, ToPort = 22, CidrIpv4 = "0.0.0.0/0" } },
        Instances: new() { new Instance { InstanceId = "i-bastion", Tags = Name("bastion-1") } });

    private static TransitData NetTransit()
    {
        var attachments = new List<TransitGatewayAttachment>();
        foreach (var (tgw, _) in Tgws) attachments.Add(Att($"tgw-attach-egress-{tgw}", tgw, "vpc", "vpc-egress", NetAccount, "egress"));
        attachments.Add(Att("tgw-attach-prod", "tgw-egress", "vpc", "vpc-prod", ProdAccount, "prod-ue1"));
        attachments.Add(Att("tgw-attach-shared-services", "tgw-egress", "vpc", "vpc-shared-services", ProdAccount, "shared-services"));
        attachments.Add(Att("tgw-attach-spoke-d-east", "tgw-domain-b", "vpc", "vpc-spoke-d-east", NetAccount, "spoke-d-east"));
        attachments.Add(Att("tgw-attach-spoke-d-west", "tgw-domain-b", "vpc", "vpc-spoke-d-west", NetAccount, "spoke-d-west"));
        attachments.Add(Att("tgw-attach-spoke-e", "tgw-domain-c", "vpc", "vpc-spoke-e", NetAccount, "spoke-e"));
        foreach (var v in Vpns) attachments.Add(Att($"tgw-attach-{v.Id}", v.Tgw, "vpn", v.Id, NetAccount, v.Name));
        attachments.Add(Att("tgw-attach-partner", "tgw-egress", "peering", "tgw-partner", PeerAccount, "partner-net"));
        attachments.Add(Att("tgw-attach-colo", "tgw-egress", "peering", "tgw-colo", PeerAccount, "colo-west"));

        return new TransitData(
            Gateways: Tgws.Select(t => new TransitGateway { TransitGatewayId = t.Tgw, OwnerId = NetAccount, State = TransitGatewayState.Available, Tags = Name(t.Name) }).ToList(),
            Attachments: attachments,
            PeeringAttachments: new()
            {
                Peer("tgw-attach-partner", "tgw-partner", "us-west-2"),
                Peer("tgw-attach-colo", "tgw-colo", "us-west-1"),
            },
            RouteTables: Tgws.Select(t => new TgwRouteTableData(
                new TransitGatewayRouteTable { TransitGatewayRouteTableId = $"tgw-rtb-{t.Tgw}", TransitGatewayId = t.Tgw, Tags = Name($"{t.Name}-rt") },
                Associations: attachments.Where(a => a.TransitGatewayId == t.Tgw).Select(a => new TransitGatewayRouteTableAssociation { TransitGatewayAttachmentId = a.TransitGatewayAttachmentId }).ToList(),
                Propagations: new(),
                Routes: new()
                {
                    new TransitGatewayRoute { DestinationCidrBlock = "0.0.0.0/0", State = TransitGatewayRouteState.Active, Type = TransitGatewayRouteType.Static,
                        TransitGatewayAttachments = new() { new TransitGatewayRouteAttachment { TransitGatewayAttachmentId = $"tgw-attach-egress-{t.Tgw}" } } },
                })).ToList(),
            ReadableHubs: Tgws.Select(t => t.Tgw).ToHashSet());
    }

    private static VpnData NetVpn() => new(
        Gateways: new(),
        Connections: Vpns.Select((v, i) => new VpnConnection
        {
            VpnConnectionId = v.Id, TransitGatewayId = v.Tgw, CustomerGatewayId = $"cgw-{i}", State = VpnState.Available, Tags = Name(v.Name),
            Options = new VpnConnectionOptions { StaticRoutesOnly = v.Static },
            VgwTelemetry = new()
            {
                new VgwTelemetry { OutsideIpAddress = $"203.0.113.{100 + i * 2}", Status = TelemetryStatus.UP },
                new VgwTelemetry { OutsideIpAddress = $"203.0.113.{101 + i * 2}", Status = v.Degraded ? TelemetryStatus.DOWN : TelemetryStatus.UP },
            },
        }).ToList(),
        CustomerGateways: Vpns.Select((v, i) => new CustomerGateway { CustomerGatewayId = $"cgw-{i}", IpAddress = $"198.51.100.{10 + i}", BgpAsn = $"{65010 + i}", DeviceName = $"{v.Name} edge", State = "available" }).ToList());

    private static CoreNetworkData ProdCore() => new(
        Vpcs: new() { new Vpc { VpcId = "vpc-prod", OwnerId = ProdAccount, CidrBlock = "10.20.0.0/16", State = VpcState.Available, Tags = Name("prod-ue1") } },
        Subnets: new() { Sub("subnet-prod-app-1a", "vpc-prod", "10.20.1.0/24", "us-east-1a", "app-1a") },
        RouteTables: new() { Rt("rtb-prod-app", "vpc-prod", new[] { "subnet-prod-app-1a" },
            new Route { DestinationCidrBlock = "0.0.0.0/0", TransitGatewayId = "tgw-egress", State = RouteState.Active }) },
        NetworkAcls: new(), InternetGateways: new(), EgressOnlyGateways: new(), NatGateways: new(), PrefixLists: new());

    /// The prod account sees the shared TGW and its own attachment, but cannot read the TGW's route tables.
    private static TransitData ProdTransit() => new(
        Gateways: new() { new TransitGateway { TransitGatewayId = "tgw-egress", OwnerId = NetAccount, State = TransitGatewayState.Available } },
        Attachments: new() { Att("tgw-attach-prod", "tgw-egress", "vpc", "vpc-prod", ProdAccount, null) },
        PeeringAttachments: new(), RouteTables: new(), ReadableHubs: new());

    private static Subnet Sub(string id, string vpc, string cidr, string az, string name) =>
        new() { SubnetId = id, VpcId = vpc, CidrBlock = cidr, AvailabilityZone = az, Tags = Name(name), State = SubnetState.Available };

    private static RouteTable Rt(string id, string vpc, string[] subnets, params Route[] routes) =>
        new() { RouteTableId = id, VpcId = vpc, Associations = subnets.Select(s => new RouteTableAssociation { SubnetId = s }).ToList(), Routes = routes.ToList() };

    private static NatGateway Nat(string id, string subnet, string ip, string alloc) => new()
    {
        NatGatewayId = id, VpcId = "vpc-egress", SubnetId = subnet, State = NatGatewayState.Available, ConnectivityType = ConnectivityType.Public,
        NatGatewayAddresses = new() { new NatGatewayAddress { PublicIp = ip, AllocationId = alloc } },
    };

    private static TransitGatewayAttachment Att(string id, string tgw, string type, string resource, string owner, string? name) => new()
    {
        TransitGatewayAttachmentId = id, TransitGatewayId = tgw, TransitGatewayOwnerId = NetAccount, ResourceOwnerId = owner,
        ResourceType = new TransitGatewayAttachmentResourceType(type), ResourceId = resource, State = TransitGatewayAttachmentState.Available,
        Tags = name == null ? null : Name(name),
    };

    private static TransitGatewayPeeringAttachment Peer(string id, string peerTgw, string peerRegion) => new()
    {
        TransitGatewayAttachmentId = id,
        RequesterTgwInfo = new PeeringTgwInfo { TransitGatewayId = "tgw-egress", OwnerId = NetAccount, Region = Region },
        AccepterTgwInfo = new PeeringTgwInfo { TransitGatewayId = peerTgw, OwnerId = PeerAccount, Region = peerRegion },
    };
}
