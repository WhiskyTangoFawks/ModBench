using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

[assembly: HostingStartup(typeof(MEditService.Http.Tests.Api.StalledStartup))]

namespace MEditService.Http.Tests.Api;

/// <summary>Named by ASPNETCORE_HOSTINGSTARTUPASSEMBLIES in a spawned backend, it holds the host in
/// its start until the host is asked to stop.</summary>
public sealed class StalledStartup : IHostingStartup
{
    public const string Marker = "startup stalled";

    public void Configure(IWebHostBuilder builder) =>
        builder.ConfigureServices(services => services.AddHostedService<Stall>());

    private sealed class Stall : IHostedService
    {
        public async Task StartAsync(CancellationToken cancellationToken)
        {
            Console.Out.WriteLine(Marker);
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
