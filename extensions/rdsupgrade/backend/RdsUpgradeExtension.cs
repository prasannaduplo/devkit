using Duplo.Ai.Studio.Extensibility;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace Duplo.Extension.RdsUpgrade;

/// <summary>
/// Registers the background worker. The studio discovers <see cref="IDuploExtension"/> in a loaded extension
/// and calls <see cref="Configure"/> once at startup — the only way an extension adds a hosted service.
/// </summary>
public class RdsUpgradeExtension : IDuploExtension
{
    public void Configure(WebApplicationBuilder builder)
    {
        builder.Services.AddHostedService<RdsUpgradeWorker>();
    }
}
