using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Composition;

/// <summary>Where the gesture handlers are built (ADR-0014), because only this assembly
/// can name the internal module they share. The host calls this one method.</summary>
public static class CommandHandlers
{
    public static IServiceCollection AddCommandHandlers(this IServiceCollection services)
    {
        // One instance each for the write side: they hold singletons and decide nothing per request.
        services.AddSingleton(sp => new LoadOrderResolution(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<SchemaReflector>()));

        services.AddSingleton(sp => new WriteTargets(
            sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new EditRecordChangesHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderResolution>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<EditRecordChangesHandler>>()));

        services.AddSingleton(sp => new DeleteRecordChangesHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<ILogger<DeleteRecordChangesHandler>>()));

        services.AddSingleton(sp => new CreateRecordChangesHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderResolution>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<CreateRecordChangesHandler>>()));

        // The container half both copy modes take. Held once: singletons only, nothing per
        // request.
        services.AddSingleton(sp => new RecordCopy(
            sp.GetRequiredService<LoadOrderResolution>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(RecordCopy))));

        services.AddSingleton(sp => new CopyRecordChangesHandler(
            new OverrideCopy(
                sp.GetRequiredService<WriteTargets>(),
                sp.GetRequiredService<RecordCopy>(),
                sp.GetRequiredService<LoadOrderResolution>(),
                sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(OverrideCopy))),
            new NewRecordCopy(
                sp.GetRequiredService<WriteTargets>(),
                sp.GetRequiredService<RecordCopy>(),
                sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(NewRecordCopy))),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<LoadOrderResolution>(),
            sp.GetRequiredService<ILogger<CopyRecordChangesHandler>>()));

        services.AddSingleton(sp => new TrackHandler(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<INotificationPublisher>(),
            sp.GetRequiredService<ILogger<TrackHandler>>()));

        services.AddSingleton(sp => new DecompilePluginHandler(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<ILogger<DecompilePluginHandler>>()));

        services.AddSingleton(sp => new RenameSourceChangesHandler(sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new MoveLastWrittenHandler(sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new CompilePluginHandler(
            new PluginCompileService(
                sp.GetRequiredService<LoadOrderHolder>(),
                sp.GetRequiredService<SchemaReflector>(),
                sp.GetRequiredService<IPluginAdapter>(),
                sp.GetRequiredService<ILogger<PluginCompileService>>()),
            sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new CreatePluginHandler(
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<ILogger<CreatePluginHandler>>()));

        services.AddSingleton(sp => new PutLoadOrderHandler(
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<SchemaReflector>(),
            new ExternalChangeCheck(
                sp.GetRequiredService<INotificationPublisher>(),
                sp.GetRequiredService<IPluginAdapter>())));

        return services;
    }
}
