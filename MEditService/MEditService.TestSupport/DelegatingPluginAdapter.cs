using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>Forwards every member to the real adapter so a double states only the verb it cares
/// about: these tests want real plugins read with one seam intercepted, not a fake adapter.</summary>
public abstract class DelegatingPluginAdapter(IPluginAdapter inner) : IPluginAdapter
{
    public virtual Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        inner.OpenDocuments(modPath, gameRelease, schemas, strings);

    public virtual Answer<IPluginRecords, PluginFailure> OpenRecordLookup(
        RegisteredPlugin plugin, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        inner.OpenRecordLookup(plugin, gameRelease, schemas);

    public virtual Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) =>
        inner.ReadContent(modPath, gameRelease, strings);

    public virtual bool Exists(string pluginPath) => inner.Exists(pluginPath);

    public virtual string? HashOf(string pluginPath) => inner.HashOf(pluginPath);

    public virtual void KeepHashesOf(IReadOnlySet<string> pluginPaths) => inner.KeepHashesOf(pluginPaths);

    public virtual Answer<FileClaim, PluginFailure> ClaimOf(string pluginPath) => inner.ClaimOf(pluginPath);

    public virtual bool GameFolderExists(string gameFolder) => inner.GameFolderExists(gameFolder);

    public virtual LinkAnswers LinkTargets(
        LoadOrderSnapshot loadOrder, RegisteredPlugin compiled, IReadOnlyCollection<string> formKeys) =>
        inner.LinkTargets(loadOrder, compiled, formKeys);

    public virtual Task<Answer<CompiledTree, PluginFailure>> ReadTreeAsync(
        IReadOnlyList<TreeFile> files, GameRelease gameRelease, CancellationToken cancel = default) =>
        inner.ReadTreeAsync(files, gameRelease, cancel);

    public virtual Task<Answer<string, PluginFailure>> WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder,
        CancellationToken cancel = default) =>
        inner.WriteFromTreeAsync(files, destinationPath, masterOrder, cancel);

    public virtual Task<Answer<PluginSource, PluginFailure>> ReadSourceOfAsync(
        RegisteredPlugin plugin, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default) =>
        inner.ReadSourceOfAsync(plugin, gameRelease, strings, cancel);

    public virtual Answer<string?, PluginFailure> DivergenceFrom(
        string pluginFileName, string pluginFilePath, string recompiledPath, GameRelease gameRelease, PluginStrings strings) =>
        inner.DivergenceFrom(pluginFileName, pluginFilePath, recompiledPath, gameRelease, strings);

    public virtual Task<Answer<PluginByteComparison, PluginFailure>> CompareBytesAsync(
        string originalPath, string recompiledPath, CancellationToken cancel = default) =>
        inner.CompareBytesAsync(originalPath, recompiledPath, cancel);

    public virtual Task<Answer<EmptyPluginCreated, PluginFailure>> CreateAndWriteAsync(ModKey modKey, string folder, GameRelease gameRelease) =>
        inner.CreateAndWriteAsync(modKey, folder, gameRelease);

    public virtual string PathOfEmpty(ModKey modKey, string folder) => inner.PathOfEmpty(modKey, folder);

    public virtual Answer<EmptyPluginTakeBack, PluginFailure> TakeBackEmpty(ModKey modKey, string folder, string written) =>
        inner.TakeBackEmpty(modKey, folder, written);
}
