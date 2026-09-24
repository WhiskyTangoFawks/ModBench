using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Composition;

/// <summary>Where the gesture handlers are built (ADR-0014 invariant 3), because only this assembly
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
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(WriteTargets))));

        services.AddSingleton(sp => new EditRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<EditRecordHandler>>()));

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

        // The container half both copy gestures take. Held once: singletons only, nothing per
        // request.
        services.AddSingleton(sp => new RecordCopy(
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(RecordCopy)),
            sp.GetRequiredService<RecordTextCodec>()));

        services.AddSingleton(sp => new CopyRecordAsOverrideHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<RecordCopy>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<ILogger<CopyRecordAsOverrideHandler>>()));

        services.AddSingleton(sp => new CopyRecordAsNewRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<RecordCopy>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<ILogger<CopyRecordAsNewRecordHandler>>()));

        services.AddSingleton(sp => new RenumberRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<RenumberRecordHandler>>()));

        services.AddSingleton(sp => new PeekNextFreeFormKeyHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new TrackHandler(
            sp.GetRequiredService<TrackService>(),
            sp.GetRequiredService<LoadOrderHolder>()));

        // The watcher's verb, not a gesture: built here so the port it publishes through is the
        // composition root's, never borrowed from the watcher that calls it.
        services.AddSingleton(sp => new TrackedModSettled(sp.GetRequiredService<INotificationPublisher>()));

        services.AddSingleton(sp => new CompilePluginHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<PluginCompileService>()));

        services.AddSingleton(sp => new AbsorbExternalChangeHandler(
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<ILogger<AbsorbExternalChangeHandler>>()));

        services.AddSingleton(sp => new KeepExternalChangeHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<ILogger<KeepExternalChangeHandler>>()));

        services.AddSingleton(sp => new CreatePluginHandler(
            sp.GetRequiredService<IPluginAdapter>(),
            sp.GetRequiredService<TrackService>(),
            sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new RebaseEditBranchHandler(
            sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new ContinueRebaseEditBranchHandler(
            sp.GetRequiredService<LoadOrderHolder>()));

        services.AddSingleton(sp => new PutLoadOrderHandler(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<IPluginAdapter>()));

        return services;
    }
}
