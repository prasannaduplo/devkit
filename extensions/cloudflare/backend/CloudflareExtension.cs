using Duplo.Ai.Studio.Extensibility;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace Duplo.Extension.Cloudflare;

/// <summary>Registers the background worker — the studio calls <see cref="Configure"/> once when the bundle loads.</summary>
public class CloudflareExtension : IDuploExtension
{
    public void Configure(WebApplicationBuilder builder)
    {
        builder.Services.AddHostedService<CloudflareWatchWorker>();
    }
}
