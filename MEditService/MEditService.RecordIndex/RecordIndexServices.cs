using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace MEditService.RecordIndex;

/// <summary>The record index's one registration: the host takes its face.</summary>
public static class RecordIndexServices
{
    // The store's engine sizes its memory from the machine's, and cannot see the share a desktop
    // with other programs leaves it.
    private const long Gigabyte = 1_000_000_000;

    public static IServiceCollection AddRecordIndex(this IServiceCollection services, long? memoryLimit = null)
    {
        services.AddSingleton(sp => new FilterInForce(sp.GetRequiredService<ILogger<FilterInForce>>(), sp.GetService<INotificationPublisher>()));
        services.AddSingleton(sp =>
        {
            var index = new Indexer(
                sp.GetRequiredService<LoadOrderHolder>(),
                sp.GetRequiredService<UnsavedDocuments>(),
                sp.GetRequiredService<IPluginAdapter>(),
                sp.GetRequiredService<ISourceAdapter>(),
                sp.GetRequiredService<SchemaReflector>(),
                sp.GetRequiredService<FilterInForce>(),
                memoryLimit ?? Gigabyte,
                sp.GetRequiredService<ILoggerFactory>(),
                sp.GetService<INotificationPublisher>(),
                sp.GetRequiredService<TimeProvider>());
            index.Subscribe();
            return index;
        });
        services.AddSingleton<IHandedWrites>(sp => sp.GetRequiredService<Indexer>());
        services.AddSingleton<IQueries>(sp => new RecordQueries(
            sp.GetRequiredService<Indexer>(), sp.GetRequiredService<FilterInForce>(), sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<SchemaReflector>(), sp.GetRequiredService<ISourceAdapter>(), sp.GetRequiredService<ILogger<RecordQueries>>()));
        services.AddHostedService<IndexAtStartup>();
        return services;
    }

    // A load order can arrive before the first query resolves the record index.
    private sealed class IndexAtStartup(IServiceProvider services) : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken)
        {
            services.GetRequiredService<IQueries>();
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
