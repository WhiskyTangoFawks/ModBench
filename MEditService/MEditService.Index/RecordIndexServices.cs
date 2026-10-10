using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace MEditService.Index;

/// <summary>The record index's one registration: the host takes its face.</summary>
public static class RecordIndexServices
{
    public static IServiceCollection AddRecordIndex(this IServiceCollection services)
    {
        services.AddSingleton<IQueries>(sp =>
        {
            var index = new Indexer(
                sp.GetRequiredService<LoadOrderHolder>(),
                sp.GetRequiredService<UnsavedDocuments>(),
                sp.GetRequiredService<IPluginAdapter>(),
                sp.GetRequiredService<ISourceAdapter>(),
                sp.GetRequiredService<SchemaReflector>(),
                sp.GetRequiredService<ILoggerFactory>(),
                sp.GetService<INotificationPublisher>(),
                sp.GetRequiredService<TimeProvider>());
            index.Subscribe();
            return new RecordQueries(
                index, sp.GetRequiredService<LoadOrderHolder>(), sp.GetRequiredService<SchemaReflector>(),
                sp.GetRequiredService<ISourceAdapter>(), sp.GetRequiredService<ILogger<RecordQueries>>());
        });
        services.AddHostedService<IndexAtStartup>();
        return services;
    }

    // A load order can arrive before the first query resolves the index.
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
