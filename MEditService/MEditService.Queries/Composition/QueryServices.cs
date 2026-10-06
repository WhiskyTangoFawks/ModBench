using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Queries.Composition;

public static class QueryServices
{
    public static IServiceCollection AddQueries(this IServiceCollection services)
    {
        services.AddSingleton<IRecordQueryService, RecordQueryService>();
        services.AddSingleton<MalformedPluginQueryService>();
        services.AddSingleton<PluginDependantsQueryService>();
        services.AddSingleton<PluginProblemQueryService>();
        services.AddSingleton<IWorldspaceQueryService, WorldspaceQueryService>();
        services.AddSingleton<ContainerChildQueryService>();
        services.AddSingleton<ChildRecordQueryService>();
        return services;
    }
}
