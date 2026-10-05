using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>Forwards every member to the real adapter so a double states only the verb it cares
/// about: these tests want real plugins read with one seam intercepted, not a fake adapter.</summary>
public abstract class DelegatingPluginAdapter(IPluginAdapter inner) : IPluginAdapter
{
    public virtual IPluginDocuments OpenDocuments(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        inner.OpenDocuments(modPath, gameRelease, schemas, strings);

    public virtual IPluginRecordLookup OpenRecordLookup(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        inner.OpenRecordLookup(modPath, gameRelease, schemas);

    public virtual (PluginContent Content, Exception? Unreachable) ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) =>
        inner.ReadContent(modPath, gameRelease, strings);

    public virtual bool CanRead(ModPath modPath) => inner.CanRead(modPath);

    public virtual LinkAnswers LinkTargets(
        IReadOnlyList<ModPath> loadOrder, GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, IReadOnlyCollection<string> formKeys) =>
        inner.LinkTargets(loadOrder, gameRelease, schemas, formKeys);

    public virtual Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files, RecordTextCodec codec, GameRelease gameRelease, CancellationToken cancel = default) =>
        inner.ReadTreeAsync(files, codec, gameRelease, cancel);

    public virtual Task WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder,
        CancellationToken cancel = default) =>
        inner.WriteFromTreeAsync(files, destinationPath, masterOrder, cancel);

    public virtual Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceAsync(
        ModPath modPath, string registeredName, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default) =>
        inner.ReadSourceAsync(modPath, registeredName, gameRelease, strings, cancel);

    public virtual Task<IReadOnlyList<TreeFile>> ReadPristineFilesAsync(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default) =>
        inner.ReadPristineFilesAsync(modPath, gameRelease, strings, cancel);

    public virtual string? DivergenceBetween(ModPath modPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings) =>
        inner.DivergenceBetween(modPath, recompiledPath, gameRelease, strings);

    public virtual Task<PluginByteComparison> CompareBytesAsync(string originalPath, string recompiledPath, CancellationToken cancel = default) =>
        inner.CompareBytesAsync(originalPath, recompiledPath, cancel);

    public virtual Task<EmptyPluginWrite> CreateAndWriteAsync(ModKey modKey, string folder, GameRelease gameRelease) =>
        inner.CreateAndWriteAsync(modKey, folder, gameRelease);
}
