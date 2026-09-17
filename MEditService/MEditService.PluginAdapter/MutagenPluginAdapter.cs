using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Mutagen.Bethesda.Strings.DI;

namespace MEditService.PluginAdapter;

/// <summary>A mod opened for reading, disposed when the caller is done with its bytes. Internal:
/// the live mod is the adapter's own, and the port answers in documents and facts.</summary>
internal interface ILoadedMod : IDisposable
{
    IModGetter Getter { get; }
}

/// <summary>The one implementation: Mutagen's own mod factory and write builder, reached by the
/// release the caller passed and never by a game this code names.</summary>
public sealed class MutagenPluginAdapter : IPluginAdapter
{
    /// <summary>The one instance, for a caller with no constructor to inject the port
    /// through.</summary>
    public static readonly IPluginAdapter Instance = new MutagenPluginAdapter();

    internal static ILoadedMod OpenForRead(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        => new LoadedMod(ModFactory.ImportGetter(modPath, gameRelease, ReadParameters(strings)));

    public IPluginDocuments OpenDocuments(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null)
    {
        ILoadedMod? loaded = OpenForRead(modPath, gameRelease, strings);
        try
        {
            var documents = ModDocuments.Of(loaded.Getter, schemas, loaded);
            loaded = null;
            return documents;
        }
        finally
        {
            loaded?.Dispose();
        }
    }

    public IPluginRecordLookup OpenRecordLookup(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        ILoadedMod? loaded = OpenForRead(modPath, gameRelease);
        try
        {
            var lookup = ModDocuments.LookupOf(loaded.Getter, schemas, loaded);
            loaded = null;
            return lookup;
        }
        finally
        {
            loaded?.Dispose();
        }
    }

    public bool CanRead(ModPath modPath)
    {
        try
        {
            using var stream = File.OpenRead(modPath.Path);
            stream.CopyTo(Stream.Null);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    public IReadOnlyList<string> ImplicitPluginsIn(string dataFolder, GameRelease gameRelease) =>
        ImplicitPlugins.In(dataFolder, gameRelease);

    public (PluginContent Content, Exception? Unreachable) ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
    {
        using var loaded = OpenForRead(modPath, gameRelease, strings);
        return OpenedPlugins.ContentIn(loaded.Getter, modPath.ModKey.FileName.String);
    }

    public PluginFormIds ReadFormIds(ModPath modPath, GameRelease gameRelease)
    {
        using var loaded = OpenForRead(modPath, gameRelease);
        return OpenedPlugins.FormIdsIn(loaded.Getter, modPath.ModKey.FileName.String);
    }

    public LinkAnswers LinkTargets(
        IReadOnlyList<ModPath> loadOrder,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys) =>
        LoadOrderLinks.Targets(loadOrder, gameRelease, schemas, formKeys);

    public bool LinksTo(ModPath modPath, GameRelease gameRelease, FormKey target, FormKey? itself)
    {
        using var loaded = OpenForRead(modPath, gameRelease);
        return OpenedPlugins.LinksTo(loaded.Getter, modPath.ModKey.FileName.String, target, itself);
    }

    public Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        RecordTextCodec codec,
        GameRelease gameRelease,
        CancellationToken cancel = default) =>
        PluginTrees.ReadTreeAsync(files, codec, gameRelease, cancel);

    public Task WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default) =>
        PluginTrees.WriteFromTreeAsync(files, destinationPath, deserialize: null, cancel);

    public Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceAsync(
        ModPath modPath, string registeredName, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default) =>
        PluginTrees.ReadAsync(modPath, registeredName, gameRelease, strings, cancel);

    public Task<IReadOnlyList<TreeFile>> ReadPristineFilesAsync(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default) =>
        PluginTrees.ReadPristineFilesAsync(modPath, gameRelease, strings, cancel);

    public IEnumerable<(RecordIdentity Identity, string Text)> RecordDocumentsOf(
        ModPath modPath,
        GameRelease gameRelease,
        PluginStrings strings,
        RecordTextCodec codec,
        IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        PluginTrees.RecordDocumentsOf(modPath, gameRelease, strings, codec, schemas);

    public string? DivergenceBetween(
        ModPath modPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings) =>
        PluginTrees.DivergenceBetween(modPath, recompiledPath, gameRelease, strings)?.Describe();

    internal static IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        => ModFactory.ImportSetter(modPath, gameRelease, ReadParameters(strings));

    private static BinaryReadParameters? ReadParameters(PluginStrings? strings) =>
        strings is { } named ? LocalizedStrings.ForRead(named) : null;

    internal static IMod CreateEmpty(ModKey modKey, GameRelease gameRelease)
        => ModFactory.Activator(modKey, gameRelease);

    public async Task CreateAndWriteAsync(
        ModKey modKey, string destinationPath, GameRelease gameRelease, bool smallMaster)
    {
        // Never-assume-exclusive-ownership: the destination may be a mod folder nothing has written
        // into yet — a brand-new mod, or overwrite/ before its first file.
        Directory.CreateDirectory(PathShape.DirectoryOf(destinationPath));
        if (File.Exists(destinationPath))
            throw new IOException($"Plugin file already exists: {Path.GetFileName(destinationPath)}");

        var plugin = CreateEmpty(modKey, gameRelease);
        if (smallMaster) plugin.IsSmallMaster = true;
        await WriteAsync(plugin, destinationPath);
    }

    /// <summary>Bytes at <paramref name="destinationPath"/>, with neither backup nor rename — what
    /// <see cref="PluginWriter"/> adds to replace a plugin in place. Null takes Mutagen's
    /// own master order (ADR-0008) and strings folder.</summary>
    internal static async Task WriteAsync(
        IMod plugin,
        string destinationPath,
        IReadOnlyList<string>? masterOrder = null,
        string? stringsFolder = null)
    {
        // ADR-0006: the header's stored NextObjectID and record count are written as stored, never
        // recomputed. Mutagen's Iterate defaults re-derive both, and real override plugins routinely
        // carry stored values that match neither.
        var writeBuilder = plugin.BeginWrite
            .ToPath(destinationPath)
            .WithLoadOrderFromHeaderMasters()
            .WithNoDataFolder()
            .NoNextFormIDProcessing()
            .WithRecordCount(RecordCountOption.NoCheck);

        // A caller writing to a temp file needs its own strings folder. Mutagen's write path
        // disposes whichever StringsWriter it holds, so this one is ours only on failure.
        StringsWriter? stringsWriter = null;
        try
        {
            if (stringsFolder != null && plugin.UsingLocalization)
            {
                stringsWriter = new StringsWriter(
                    plugin.GameRelease, plugin.ModKey,
                    writeDirectory: stringsFolder,
                    encodingProvider: MutagenEncoding.Default);
                writeBuilder = writeBuilder.WithStringsWriter(stringsWriter);
                stringsWriter = null;
            }
        }
        finally
        {
            stringsWriter?.Dispose();
        }

        // ADR-0008: masters are ordered explicitly from the load order when supplied, so the written
        // file's master list matches what xEdit shows (ADR-0018 at the file level).
        if (masterOrder != null)
            writeBuilder = writeBuilder.WithMastersListOrdering(masterOrder.Select(name => ModKey.FromFileName(name)));

        await writeBuilder.WriteAsync();
    }

    private sealed class LoadedMod(IModDisposeGetter inner) : ILoadedMod
    {
        public IModGetter Getter => inner;
        public void Dispose() => inner.Dispose();
    }
}
