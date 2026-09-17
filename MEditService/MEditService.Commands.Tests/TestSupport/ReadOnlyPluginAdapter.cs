using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.TestSupport;

/// <summary>The real adapter's reads, throwing on every write verb so a test that reaches one names
/// itself rather than passing on a silent stub.</summary>
public abstract class ReadOnlyPluginAdapter : IPluginAdapter
{
    private static IPluginAdapter Real => MutagenPluginAdapter.Instance;

    public IPluginDocuments OpenDocuments(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        Real.OpenDocuments(modPath, gameRelease, schemas, strings);

    public IPluginRecordLookup OpenRecordLookup(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Real.OpenRecordLookup(modPath, gameRelease, schemas);

    public virtual (PluginContent Content, Exception? Unreachable) ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) =>
        Real.ReadContent(modPath, gameRelease, strings);

    public virtual bool CanRead(ModPath modPath) => Real.CanRead(modPath);

    public virtual IReadOnlyList<string> ImplicitPluginsIn(string dataFolder, GameRelease gameRelease) =>
        Real.ImplicitPluginsIn(dataFolder, gameRelease);

    public PluginFormIds ReadFormIds(ModPath modPath, GameRelease gameRelease) =>
        Real.ReadFormIds(modPath, gameRelease);

    public virtual LinkAnswers LinkTargets(
        IReadOnlyList<ModPath> loadOrder,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys) =>
        Real.LinkTargets(loadOrder, gameRelease, schemas, formKeys);

    public bool LinksTo(ModPath modPath, GameRelease gameRelease, FormKey target, FormKey? itself) =>
        Real.LinksTo(modPath, gameRelease, target, itself);

    public Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        RecordTextCodec codec,
        GameRelease gameRelease,
        CancellationToken cancel = default) =>
        Real.ReadTreeAsync(files, codec, gameRelease, cancel);

    public Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceAsync(
        ModPath modPath, string registeredName, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default) =>
        Real.ReadSourceAsync(modPath, registeredName, gameRelease, strings, cancel);

    public Task<IReadOnlyList<TreeFile>> ReadPristineFilesAsync(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default) =>
        Real.ReadPristineFilesAsync(modPath, gameRelease, strings, cancel);

    public IEnumerable<(RecordIdentity Identity, string Text)> RecordDocumentsOf(
        ModPath modPath,
        GameRelease gameRelease,
        PluginStrings strings,
        RecordTextCodec codec,
        IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Real.RecordDocumentsOf(modPath, gameRelease, strings, codec, schemas);

    public string? DivergenceBetween(
        ModPath modPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings) =>
        Real.DivergenceBetween(modPath, recompiledPath, gameRelease, strings);

    public virtual Task WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");

    public Task CreateAndWriteAsync(
        ModKey modKey, string destinationPath, GameRelease gameRelease, bool smallMaster) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");
}
