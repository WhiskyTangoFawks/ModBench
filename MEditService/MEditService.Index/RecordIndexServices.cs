using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace MEditService.Index;

/// <summary>The record index's one registration: the host takes its query services, the box's face.</summary>
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
                sp.GetRequiredService<TimeProvider>());
            index.Subscribe();
            return index;
        });
        services.AddHostedService<IndexAtStartup>();
        services.AddSingleton<IRecordQueryService, RecordQueryService>();
        services.AddSingleton<IWorldspaceQueryService, WorldspaceQueryService>();
        services.AddSingleton(sp => new MalformedPluginQueryService(
            sp.GetRequiredService<IQueryIndex>(), sp.GetRequiredService<LoadOrderHolder>()));
        services.AddSingleton(sp => new PluginDependantsQueryService(
            sp.GetRequiredService<IQueryIndex>(), sp.GetRequiredService<LoadOrderHolder>()));
        services.AddSingleton<PluginExtensionsQueryService>();
        services.AddSingleton(sp => new PluginProblemQueryService(
            sp.GetRequiredService<IQueryIndex>(), sp.GetRequiredService<LoadOrderHolder>()));
        services.AddSingleton(sp => new ContainerChildQueryService(
            sp.GetRequiredService<IQueryIndex>(), sp.GetRequiredService<LoadOrderHolder>()));
        services.AddSingleton(sp => new ChildRecordQueryService(sp.GetRequiredService<IQueryIndex>()));
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
