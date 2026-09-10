using MEditService.Core.Commands;
using MEditService.Core.Composition;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MEditService.Tests.TestSupport;

/// <summary>The write side as the composition root builds it: the one registration the host calls,
/// over the held load order. Nothing here names the module the handlers share — the handlers are its
/// tests.</summary>
internal static class TestEditService
{
    /// <summary>Every handler, from the registration the service itself runs. One provider per call,
    /// so two holders get two independent write sides.</summary>
    internal static IServiceProvider Over(LoadOrderHolder holder, Action<ILoggingBuilder>? logging = null) =>
        new ServiceCollection()
            .AddLogging(logging ?? (_ => { }))
            .AddSingleton(holder)
            .AddSingleton<IModImporter, DefaultModImporter>()
            .AddSingleton<RecordTextCodec>()
            .AddSingleton(SharedSchemaReflector.Instance)
            .AddSingleton<Func<LoadOrder, FormLinkResolver>>(sp => held => new FormLinkResolver(
                held, sp.GetRequiredService<IModImporter>(), sp.GetRequiredService<SchemaReflector>()))
            .AddSingleton<TrackService>()
            .AddSingleton<PluginWriter>()
            .AddSingleton<PluginCompileService>()
            .AddCommandHandlers()
            .BuildServiceProvider();

    internal static EditRecordHandler EditHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<EditRecordHandler>();

    internal static EditRecordHandler EditHandler(IndexProjector index) => EditHandler(HolderOver(index));

    internal static DeleteRecordHandler DeleteHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<DeleteRecordHandler>();

    internal static CreateRecordHandler CreateHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CreateRecordHandler>();

    internal static CreateRecordHandler CreateHandler(IndexProjector index) => CreateHandler(HolderOver(index));

    internal static CopyRecordAsOverrideHandler CopyAsOverrideHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CopyRecordAsOverrideHandler>();

    internal static CopyRecordAsNewRecordHandler CopyAsNewHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CopyRecordAsNewRecordHandler>();

    internal static CopyRecordAsNewRecordHandler CopyAsNewHandler(IndexProjector index) =>
        CopyAsNewHandler(HolderOver(index));

    internal static CompilePluginHandler CompileHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CompilePluginHandler>();

    internal static AbsorbExternalChangeHandler AbsorbHandler() =>
        Over(new LoadOrderHolder()).GetRequiredService<AbsorbExternalChangeHandler>();

    internal static KeepExternalChangeHandler KeepHandler(Action<ILoggingBuilder>? logging = null) =>
        Over(new LoadOrderHolder(), logging).GetRequiredService<KeepExternalChangeHandler>();

    internal static RebaseEditBranchHandler RebaseHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<RebaseEditBranchHandler>();

    internal static RebaseEditBranchHandler RebaseHandler(IndexProjector index) => RebaseHandler(HolderOver(index));

    internal static ContinueRebaseEditBranchHandler ContinueRebaseHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<ContinueRebaseEditBranchHandler>();

    internal static ContinueRebaseEditBranchHandler ContinueRebaseHandler(IndexProjector index) =>
        ContinueRebaseHandler(HolderOver(index));

    internal static CreatePluginHandler PluginCreateHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CreatePluginHandler>();

    internal static PeekNextFreeFormKeyHandler PeekHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<PeekNextFreeFormKeyHandler>();

    internal static RenumberRecordHandler RenumberHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<RenumberRecordHandler>();

    /// <summary>The same handler for a test holding the Index: its held copies are the load order
    /// value the write side reads, and the Index itself never reaches the handler.</summary>
    internal static RenumberRecordHandler RenumberHandler(IndexProjector index) => RenumberHandler(HolderOver(index));

    /// <summary>A holder carrying whatever <paramref name="index"/> holds right now — reapplied per
    /// gesture, since a test can register a copy mid-run.</summary>
    internal static LoadOrderHolder HolderOver(IndexProjector index)
    {
        var holder = new LoadOrderHolder();
        Sync(holder, index);
        return holder;
    }

    internal static void Sync(LoadOrderHolder holder, IndexProjector index)
    {
        if (index.LoadOrder is { } held) holder.Apply(LoadOrder.From(held));
    }
}
