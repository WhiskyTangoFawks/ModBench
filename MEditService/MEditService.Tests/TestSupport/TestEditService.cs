using MEditService.Core.Commands;
using MEditService.Core.Composition;
using MEditService.Core.Edits;
using MEditService.Core.PluginAdapter;
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
            .AddSingleton<IPluginAdapter, MutagenPluginAdapter>()
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

    internal static AbsorbExternalChangeHandler AbsorbHandler() =>
        Over(new LoadOrderHolder()).GetRequiredService<AbsorbExternalChangeHandler>();

    internal static KeepExternalChangeHandler KeepHandler(Action<ILoggingBuilder>? logging = null) =>
        Over(new LoadOrderHolder(), logging).GetRequiredService<KeepExternalChangeHandler>();

    internal static RebaseEditBranchHandler RebaseHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<RebaseEditBranchHandler>();

    internal static ContinueRebaseEditBranchHandler ContinueRebaseHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<ContinueRebaseEditBranchHandler>();

    internal static CreatePluginHandler PluginCreateHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CreatePluginHandler>();

    internal static PeekNextFreeFormKeyHandler PeekHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<PeekNextFreeFormKeyHandler>();

    internal static RenumberRecordHandler RenumberHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<RenumberRecordHandler>();
}
