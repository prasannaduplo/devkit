using Duplo.Ai.Studio.Extensibility;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace Duplo.Extension.NetMap;

/// <summary>Registers the blueprint scan worker (boot replay; hot-load starts IHostedServices directly).</summary>
public class NetMapExtension : IDuploExtension
{
    public void Configure(WebApplicationBuilder builder)
    {
        builder.Services.AddHostedService<NetworkBlueprintWorker>();
    }
}
