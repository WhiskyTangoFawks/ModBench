using MEditService.Commands.Build;
using MEditService.Commands.Composition;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
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
        INotificationPublisher? notifications = null, UnsavedDocuments? unsaved = null, ISourceAdapter? source = null,
        IModFolderRepository? modFolders = null)
    {
        var documents = unsaved ?? new UnsavedDocuments();
        return new ServiceCollection()
            .AddLogging(logging ?? (_ => { }))
            .AddSingleton(holder)
            .AddSingleton(documents)
            .AddSingleton(source ?? new GitSourceAdapter(documents, TimeProvider.System))
            .AddSingleton(TimeProvider.System)
            .AddSingleton(modFolders ?? new ModFolderRepository(TimeProvider.System))
            .AddSingleton(notifications ?? new InMemoryNotificationPublisher())
            .AddSingleton(adapter ?? TestAdapters.Mutagen())
            .AddSingleton(SharedSchemaReflector.Instance)
            .AddCommandHandlers()
            .BuildServiceProvider();
    }

    internal static TestEditor EditHandler(LoadOrderHolder holder) =>
        new(Over(holder).GetRequiredService<EditRecordChangesHandler>());

    internal static DeleteRecordChangesHandler DeleteHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<DeleteRecordChangesHandler>();

    internal static CreateRecordChangesHandler CreateHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CreateRecordChangesHandler>();

    internal static CopyRecordChangesHandler CopyHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CopyRecordChangesHandler>();

    internal static CompilePluginHandler CompileHandler(LoadOrderHolder holder, IPluginAdapter? adapter = null) =>
        Over(holder, adapter: adapter).GetRequiredService<CompilePluginHandler>();

    internal static DecompileAndCommitModHandler DecompileAndCommitModHandler(
        LoadOrderHolder holder, IPluginAdapter? adapter = null, INotificationPublisher? notifications = null,
        ISourceAdapter? source = null) =>
        Over(holder, adapter: adapter, notifications: notifications, source: source).GetRequiredService<DecompileAndCommitModHandler>();

    internal static BuildModHandler BuildModHandler(LoadOrderHolder holder, ISourceAdapter? source = null, IModFolderRepository? modFolders = null) =>
        Over(holder, source: source, modFolders: modFolders).GetRequiredService<BuildModHandler>();

    internal static CloneSubmodulesHandler CloneSubmodulesHandler() => Over(new LoadOrderHolder()).GetRequiredService<CloneSubmodulesHandler>();

    internal static ChangeSourceManifestHandler ChangeSourceManifestHandler(IModFolderRepository modFolders) =>
        Over(new LoadOrderHolder(), modFolders: modFolders).GetRequiredService<ChangeSourceManifestHandler>();

    internal static DecompilePluginHandler DecompileHandler(LoadOrderHolder holder, IPluginAdapter? adapter = null) =>
        Over(holder, adapter: adapter).GetRequiredService<DecompilePluginHandler>();

    internal static CreatePluginHandler PluginCreateHandler(LoadOrderHolder holder, IPluginAdapter? adapter = null) =>
        Over(holder, adapter: adapter).GetRequiredService<CreatePluginHandler>();

    internal static CreatePluginInModHandler PluginCreateInModHandler(LoadOrderHolder holder) =>
        Over(holder).GetRequiredService<CreatePluginInModHandler>();

    internal static PutLoadOrderHandler PutLoadOrderHandler(
        LoadOrderHolder holder, INotificationPublisher? notifications = null, IPluginAdapter? adapter = null) =>
        Over(holder, adapter: adapter, notifications: notifications).GetRequiredService<PutLoadOrderHandler>();
}
