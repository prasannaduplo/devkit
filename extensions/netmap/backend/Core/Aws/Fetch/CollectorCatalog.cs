namespace Duplo.Extension.NetMap.Core.Aws.Fetch;

public static class CollectorCatalog
{
    public static readonly IReadOnlyList<ICollector> All = new ICollector[]
    {
        new CoreNetworkCollector(), new InterfacesCollector(), new LoadBalancersCollector(), new EndpointsCollector(),
        new TransitCollector(), new VpnCollector(), new PeeringCollector(), new DnsResolverCollector(),
        new FlowLogsCollector(), new DnsZonesCollector(),
    };

    public static ICollector Get(string id) =>
        All.FirstOrDefault(c => c.Descriptor.Id == id) ?? throw new InvalidOperationException($"Unknown collector '{id}'.");
}
