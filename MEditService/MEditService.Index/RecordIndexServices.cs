using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace MEditService.Index;

/// <summary>The record index's one registration: the host takes the index as <see cref="IQueryIndex"/>.
/// A TaskScheduler in the container runs a rebuild's refill.</summary>
public static class RecordIndexServices
{
    public static IServiceCollection AddRecordIndex(this IServiceCollection services)
    {
        services.AddSingleton<IQueryIndex>(sp =>
        {
            var index = new Indexer(
                sp.GetRequiredService<LoadOrderHolder>(),
                sp.GetRequiredService<IPluginAdapter>(),
                sp.GetRequiredService<SchemaReflector>(),
                sp.GetRequiredService<ILoggerFactory>(),
                sp.GetService<INotificationPublisher>(),
                sp.GetRequiredService<TimeProvider>(),
                sp.GetService<TaskScheduler>());
            index.Subscribe();
            return index;
        });
        services.AddHostedService<IndexAtStartup>();
        return services;
    }

    // A load order can arrive before the first query resolves the index.
    private sealed class IndexAtStartup(IServiceProvider services) : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken)
        {
            services.GetRequiredService<IQueryIndex>();
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
