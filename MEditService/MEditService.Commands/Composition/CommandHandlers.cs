using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
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
        // One instance for the write side: it holds singletons and decides nothing per request, and
        // a handler that built its own would answer from the same four.
        services.AddSingleton(sp => new WriteTargets(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>()));

        services.AddSingleton(sp => new EditRecordChangesHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<EditRecordChangesHandler>>()));

        services.AddSingleton(sp => new DeleteRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<ILogger<DeleteRecordHandler>>()));

        services.AddSingleton(sp => new CreateRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<CreateRecordHandler>>()));

        // The container half both copy modes take. Held once: singletons only, nothing per
        // request.
        services.AddSingleton(sp => new RecordCopy(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(RecordCopy)),
            sp.GetRequiredService<RecordTextCodec>()));

        services.AddSingleton(sp => new CopyRecordHandler(
            new OverrideCopy(
                sp.GetRequiredService<WriteTargets>(),
                sp.GetRequiredService<RecordCopy>(),
                sp.GetRequiredService<LoadOrderHolder>(),
                sp.GetRequiredService<RecordTextCodec>(),
                sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(OverrideCopy))),
            new NewRecordCopy(
                sp.GetRequiredService<WriteTargets>(),
                sp.GetRequiredService<RecordCopy>(),
                sp.GetRequiredService<RecordTextCodec>(),
                sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(NewRecordCopy))),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<ILogger<CopyRecordHandler>>()));

        services.AddSingleton(sp => new TrackHandler(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<INotificationPublisher>(),
            sp.GetRequiredService<ILogger<TrackHandler>>()));

        services.AddSingleton(sp => new DecompilePluginHandler(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<ILogger<DecompilePluginHandler>>()));

        services.AddSingleton(sp => new RenameSourceHandler(sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new CompilePluginHandler(
            new PluginCompileService(
                sp.GetRequiredService<LoadOrderHolder>(),
                sp.GetRequiredService<SchemaReflector>(),
                sp.GetRequiredService<RecordTextCodec>(),
                sp.GetRequiredService<IPluginAdapter>(),
                sp.GetRequiredService<ILogger<PluginCompileService>>()),
            sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new CreatePluginHandler(
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<ILogger<CreatePluginHandler>>()));

        services.AddSingleton(sp => new PutLoadOrderHandler(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<SchemaReflector>(),
            new ExternalChangeCheck(
                sp.GetRequiredService<INotificationPublisher>(),
                new PluginFileHashes(sp.GetRequiredService<TimeProvider>()))));

        return services;
    }
}
