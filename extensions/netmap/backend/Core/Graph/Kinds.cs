namespace Duplo.Extension.NetMap.Core.Graph;

public static class NodeKinds
{
    public const string Account = "account";
    public const string Network = "network";
    public const string Hub = "hub";
    public const string Peering = "peering";
    public const string External = "external";
    public const string VpnConnection = "vpn-connection";
    public const string VpnGateway = "vpn-gateway";
    public const string PeerGateway = "peer-gateway";
    public const string InternetGateway = "internet-gateway";
    public const string NatGateway = "nat-gateway";
    public const string EgressOnlyGateway = "egress-only-gateway";
    public const string FirewallService = "firewall-service";
    public const string OtherGateway = "other-gateway";
    public const string Subnet = "subnet";
    public const string RouteTable = "route-table";
    public const string HubRouteTable = "hub-route-table";
    public const string HubAttachment = "hub-attachment";
    public const string LoadBalancer = "load-balancer";
    public const string Endpoint = "endpoint";
    public const string DnsZone = "dns-zone";
    public const string PublicIp = "public-ip";
    public const string ResolverEndpoint = "resolver-endpoint";
    public const string ResolverRule = "resolver-rule";
    public const string NetworkInterface = "network-interface";
    public const string Workload = "workload";
    public const string SecurityGroup = "security-group";
    public const string Nacl = "nacl";
    public const string DnsRecord = "dns-record";
    public const string VpnTunnel = "vpn-tunnel";
    public const string CidrBlock = "cidr-block";
    public const string FlowLogConfig = "flow-log-config";
    public const string DnsQueryLogConfig = "dns-query-log-config";
}

public static class EdgeKinds
{
    public const string Contains = "contains";
    public const string Associated = "associated";
    public const string Attaches = "attaches";
    public const string RoutesTo = "routes-to";
    public const string Propagates = "propagates";
    public const string TunnelsTo = "tunnels-to";
    public const string Peers = "peers";
    public const string ExitsVia = "exits-via";
    public const string Uses = "uses";
    public const string Allows = "allows";
    public const string Targets = "targets";
    public const string ResolvesTo = "resolves-to";
    public const string ForwardsTo = "forwards-to";
    public const string PlacedIn = "placed-in";
}

/// <param name="Level">Zoom level where the kind first appears: 1 very high … 4 low; 0 = not drawn.</param>
/// <param name="Icon">DuploCloud icon id (frontend sprite key).</param>
/// <param name="Container">True when the UI draws this kind as a group box that other nodes nest inside (via ParentId).</param>
public sealed record KindInfo(string Kind, int Level, string Icon, string Label, bool Container = false);

/// <summary>Kind → zoom level / icon / label. Unknown kinds (a future collector, an unrecognized cloud object) still
/// store and render: generic icon at level 3. Adding a source means adding rows here, not code paths.</summary>
public static class KindRegistry
{
    private static readonly Dictionary<string, KindInfo> Map = new KindInfo[]
    {
        new(NodeKinds.Account, 1, "account", "Account", Container: true),
        new(NodeKinds.Network, 1, "network", "Network", Container: true),
        new(NodeKinds.Hub, 1, "hub", "Transit hub", Container: true),
        new(NodeKinds.Peering, 1, "peering", "Peering"),
        new(NodeKinds.External, 1, "external", "External"),
        new(NodeKinds.VpnConnection, 2, "vpn", "Site-to-site VPN", Container: true),
        new(NodeKinds.VpnGateway, 2, "vpn-gateway", "VPN gateway"),
        new(NodeKinds.PeerGateway, 2, "site", "Customer gateway"),
        new(NodeKinds.InternetGateway, 2, "internet-gateway", "Internet gateway"),
        new(NodeKinds.NatGateway, 2, "nat", "NAT gateway"),
        new(NodeKinds.EgressOnlyGateway, 2, "egress-only", "Egress-only gateway"),
        new(NodeKinds.FirewallService, 2, "firewall", "Firewall"),
        new(NodeKinds.OtherGateway, 2, "gateway", "Gateway"),
        new(NodeKinds.Subnet, 3, "subnet", "Subnet", Container: true),
        new(NodeKinds.RouteTable, 3, "route-table", "Route table"),
        new(NodeKinds.HubRouteTable, 3, "route-table", "Hub route table"),
        new(NodeKinds.HubAttachment, 3, "attachment", "Hub attachment"),
        new(NodeKinds.LoadBalancer, 3, "load-balancer", "Load balancer"),
        new(NodeKinds.Endpoint, 3, "endpoint", "Endpoint"),
        new(NodeKinds.DnsZone, 3, "dns-zone", "DNS zone"),
        new(NodeKinds.PublicIp, 3, "public-ip", "Public IP"),
        new(NodeKinds.ResolverEndpoint, 3, "resolver", "Resolver endpoint"),
        new(NodeKinds.ResolverRule, 3, "resolver-rule", "Resolver rule"),
        new(NodeKinds.NetworkInterface, 4, "interface", "Network interface"),
        new(NodeKinds.Workload, 4, "workload", "Workload"),
        new(NodeKinds.SecurityGroup, 4, "security-group", "Security group"),
        new(NodeKinds.Nacl, 4, "nacl", "Network ACL"),
        new(NodeKinds.DnsRecord, 4, "dns-record", "DNS record"),
        new(NodeKinds.VpnTunnel, 4, "tunnel", "VPN tunnel"),
        new(NodeKinds.CidrBlock, 4, "cidr", "CIDR block"),
        new(NodeKinds.FlowLogConfig, 0, "flow-logs", "Flow log"),
        new(NodeKinds.DnsQueryLogConfig, 0, "dns-logs", "DNS query log"),
    }.ToDictionary(k => k.Kind, StringComparer.Ordinal);

    public static KindInfo Get(string kind) => Map.TryGetValue(kind, out var k) ? k : new KindInfo(kind, 3, "generic", kind, Container: false);

    public static IReadOnlyCollection<KindInfo> All => Map.Values;
}
