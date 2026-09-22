using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Composition;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The write side as the composition root builds it: the one registration the host calls,
/// over the held load order. Nothing here names the module the handlers share — the handlers are its
/// tests.</summary>
internal static class TestEditService
{
    /// <summary>Every handler, from the registration the service itself runs. One provider per call,
    /// so two holders get two independent write sides.</summary>
    internal static IServiceProvider Over(
        LoadOrderHolder holder, Action<ILoggingBuilder>? logging = null, IPluginAdapter? adapter = null,
        INotificationPublisher? notifications = null) =>
        new ServiceCollection()
            .AddLogging(logging ?? (_ => { }))
            .AddSingleton(holder)
            .AddSingleton(notifications ?? new InMemoryNotificationPublisher())
            .AddSingleton(adapter ?? new MutagenPluginAdapter())
            .AddSingleton<RecordTextCodec>()
            .AddSingleton(SharedSchemaReflector.Instance)
            .AddSingleton<TrackService>()
            .AddSingleton<PluginWriter>()
            .AddSingleton<PluginCompileService>()
            .AddCommandHandlers()
            .BuildServiceProvider();

    internal static EditRecordHandler EditHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<EditRecordHandler>();

    internal static DeleteRecordHandler DeleteHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<DeleteRecordHandler>();

    internal static CreateRecordHandler CreateHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CreateRecordHandler>();

    internal static CopyRecordAsOverrideHandler CopyAsOverrideHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CopyRecordAsOverrideHandler>();

    internal static CopyRecordAsNewRecordHandler CopyAsNewHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CopyRecordAsNewRecordHandler>();

    internal static CompilePluginHandler CompileHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CompilePluginHandler>();

    internal static TrackHandler TrackHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<TrackHandler>();

    internal static AbsorbExternalChangeHandler AbsorbHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<AbsorbExternalChangeHandler>();

    internal static KeepExternalChangeHandler KeepHandler(LoadOrderHolder holder, Action<ILoggingBuilder>? logging = null) =>
        Over(holder, logging).GetRequiredService<KeepExternalChangeHandler>();

    internal static RebaseEditBranchHandler RebaseHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<RebaseEditBranchHandler>();

    internal static ContinueRebaseEditBranchHandler ContinueRebaseHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<ContinueRebaseEditBranchHandler>();

    internal static CreatePluginHandler PluginCreateHandler(LoadOrderHolder holder, IPluginAdapter? adapter = null) =>
        Over(holder, adapter: adapter).GetRequiredService<CreatePluginHandler>();

    internal static PeekNextFreeFormKeyHandler PeekHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<PeekNextFreeFormKeyHandler>();

    internal static RenumberRecordHandler RenumberHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<RenumberRecordHandler>();

    /// <summary>The watcher's verb over the port a suite reads.</summary>
    internal static TrackedModSettled Settled(INotificationPublisher notifications) =>
        Over(new LoadOrderHolder(), notifications: notifications).GetRequiredService<TrackedModSettled>();

    internal static PutLoadOrderHandler PutLoadOrderHandler(LoadOrderHolder holder, IPluginAdapter? adapter = null) =>
        Over(holder, adapter: adapter).GetRequiredService<PutLoadOrderHandler>();
}
