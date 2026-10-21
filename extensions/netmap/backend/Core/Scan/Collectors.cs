namespace Duplo.Extension.NetMap.Core.Scan;

public static class CapabilityKeys
{
    public const string Egress = "egress";
    public const string Vpn = "vpn";
    public const string Transit = "transit";
    public const string Peering = "peering";
    public const string Inspection = "inspection";
    public const string Dns = "dns";
    public const string FlowLogs = "flowLogs";
    public const string DnsQueryLogs = "dnsQueryLogs";
    public const string Inventory = "inventory";
    public const string Workloads = "workloads";
}

/// <param name="Order">Execution order inside a (scope, region) group; later collectors read earlier parts.</param>
/// <param name="Global">Runs once per scope (region "global") after all regional units.</param>
/// <param name="Capabilities">Capabilities this collector feeds -- marked not-readable/partial when it fails.</param>
public sealed record CollectorDescriptor(string Id, int Order, bool Global, string[] Capabilities);

public static class Collectors
{
    public static readonly CollectorDescriptor CoreNetwork = new("aws.core-network", 10, false, new[] { CapabilityKeys.Egress });
    public static readonly CollectorDescriptor Interfaces = new("aws.interfaces", 20, false, new[] { CapabilityKeys.Inventory });
    public static readonly CollectorDescriptor LoadBalancers = new("aws.load-balancers", 30, false, new[] { CapabilityKeys.Inventory });
    public static readonly CollectorDescriptor Endpoints = new("aws.endpoints", 40, false, new[] { CapabilityKeys.Inspection });
    public static readonly CollectorDescriptor Transit = new("aws.transit", 50, false, new[] { CapabilityKeys.Transit });
    public static readonly CollectorDescriptor Vpn = new("aws.vpn", 60, false, new[] { CapabilityKeys.Vpn });
    public static readonly CollectorDescriptor Peering = new("aws.peering", 70, false, new[] { CapabilityKeys.Peering });
    public static readonly CollectorDescriptor DnsResolver = new("aws.dns-resolver", 80, false, new[] { CapabilityKeys.Dns, CapabilityKeys.DnsQueryLogs });
    public static readonly CollectorDescriptor FlowLogs = new("aws.flow-logs", 90, false, new[] { CapabilityKeys.FlowLogs });
    public static readonly CollectorDescriptor DnsZones = new("aws.dns-zones", 100, true, new[] { CapabilityKeys.Dns });
    // v2b workload identity: after interfaces and load balancers, whose parts they link pods / tasks / functions to.
    public static readonly CollectorDescriptor Eks = new("aws.eks", 110, false, new[] { CapabilityKeys.Workloads });
    public static readonly CollectorDescriptor Ecs = new("aws.ecs", 120, false, new[] { CapabilityKeys.Workloads });
    public static readonly CollectorDescriptor Lambda = new("aws.lambda", 130, false, new[] { CapabilityKeys.Workloads });

    public static readonly IReadOnlyList<CollectorDescriptor> All = new[]
    {
        CoreNetwork, Interfaces, LoadBalancers, Endpoints, Transit, Vpn, Peering, DnsResolver, FlowLogs, DnsZones, Eks, Ecs, Lambda,
    };
}
