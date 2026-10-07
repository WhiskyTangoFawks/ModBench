using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Composition;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>The query services as the host builds them: through <c>AddQueries()</c>, over a hand-built index.</summary>
internal static class QueryHost
{
    internal static ServiceProvider Over(IQueryIndex index, LoadOrderHolder holder, ILoggerFactory? loggerFactory = null)
    {
        var services = new ServiceCollection();
        services.AddSingleton(index);
        services.AddSingleton(holder);
        services.AddSingleton(SharedSchemaReflector.Instance);
        services.AddSingleton(loggerFactory ?? NullLoggerFactory.Instance);
        services.AddLogging();
        services.AddQueries();
        return services.BuildServiceProvider();
    }

    internal static IRecordQueryService Records(IQueryIndex index, LoadOrderHolder holder, ILoggerFactory? loggerFactory = null) =>
        Over(index, holder, loggerFactory).GetRequiredService<IRecordQueryService>();

    internal static IWorldspaceQueryService Worldspaces(IQueryIndex index) =>
        Over(index, new LoadOrderHolder()).GetRequiredService<IWorldspaceQueryService>();

    internal static ContainerChildQueryService Containers(
        IQueryIndex index, LoadOrderHolder holder, ILoggerFactory? loggerFactory = null) =>
        Over(index, holder, loggerFactory).GetRequiredService<ContainerChildQueryService>();
}
