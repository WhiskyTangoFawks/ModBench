using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Headers;
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

    // FileMode.Open, FileAccess.Read, FileShare.Read: what File.OpenRead gives, and what every
    // read below opens the same file with, so this answers for the read that follows it.
    public bool CanRead(ModPath modPath)
    {
        try
        {
            using (File.OpenRead(modPath.Path)) return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    public (PluginContent Content, Exception? Unreachable) ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
    {
        using var loaded = OpenForRead(modPath, gameRelease, strings);
        var name = modPath.ModKey.FileName.String;
        // Mutagen's game-agnostic getter carries no raw header flags and names no blueprint bit, so
        // only a game with blueprint plugins reads its header a second time.
        var isBlueprint = PluginFlagPredicates.HasBlueprintPlugins(gameRelease)
            && PluginFlagPredicates.IsBlueprint(loaded.Getter, name, ModHeaderFrame.FromPath(modPath, gameRelease).Flags);
        return OpenedPlugins.ContentIn(loaded.Getter, name, isBlueprint);
    }

    public LinkAnswers LinkTargets(
        IReadOnlyList<ModPath> loadOrder,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys) =>
        LoadOrderLinks.Targets(loadOrder, gameRelease, schemas, formKeys);

    public Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        RecordTextCodec codec,
        GameRelease gameRelease,
        CancellationToken cancel = default) =>
        PluginTrees.ReadTreeAsync(files, codec, gameRelease, cancel: cancel);

    // Not on IPluginAdapter: a test's seam onto the scratch folder's parent, so a leak-watching test
    // names its own folder instead of the system temp folder every process shares.
    public static Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        RecordTextCodec codec,
        GameRelease gameRelease,
        string scratchRoot,
        CancellationToken cancel = default) =>
        PluginTrees.ReadTreeAsync(files, codec, gameRelease, scratchRoot, cancel);

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

    public string? DivergenceBetween(
        ModPath modPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings) =>
        PluginTrees.DivergenceBetween(modPath, recompiledPath, gameRelease, strings)?.Describe();

    internal static IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        => ModFactory.ImportSetter(modPath, gameRelease, ReadParameters(strings));

    private static BinaryReadParameters? ReadParameters(PluginStrings? strings) =>
        strings is { } named ? LocalizedStrings.ForRead(named) : null;

    internal static IMod CreateEmpty(ModKey modKey, GameRelease gameRelease)
        => ModFactory.Activator(modKey, gameRelease);

    public async Task<EmptyPluginWrite> CreateAndWriteAsync(
        ModKey modKey, string folder, GameRelease gameRelease)
    {
        var destinationPath = Path.Combine(folder, modKey.FileName.String);
        if (!Directory.Exists(folder)) return EmptyPluginWrite.FolderGone;
        if (File.Exists(destinationPath)) return EmptyPluginWrite.FileExists;

        var plugin = CreateEmpty(modKey, gameRelease);
        plugin.IsMaster = modKey.Type == ModType.Master;
        plugin.IsSmallMaster = modKey.Type == ModType.Light;

        // NoModKeySync lifts Mutagen's file-name-matches-ModKey check, so the temp file needs no
        // folder of its own — nothing here can create or resurrect one. The fixed .tmp suffix
        // keeps a random plugin extension from ever landing here.
        var tempPath = Path.Combine(folder, ".medit_tmp_" + Path.GetRandomFileName() + ".tmp");
        try
        {
            await WriteAsync(plugin, tempPath, noModKeySync: true);
            File.Move(tempPath, destinationPath, overwrite: false);
            return EmptyPluginWrite.Written;
        }
        catch (IOException) when (File.Exists(destinationPath))
        {
            return EmptyPluginWrite.FileExists;
        }
        catch (DirectoryNotFoundException) when (!Directory.Exists(folder))
        {
            return EmptyPluginWrite.FolderGone;
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        }
    }

    /// <summary>Bytes at <paramref name="destinationPath"/>, written in place: the temp file and rename
    /// that replace a plugin are <see cref="PluginWriter"/>'s. Null takes Mutagen's own master order
    /// (ADR-0008) and strings folder.</summary>
    internal static async Task WriteAsync(
        IMod plugin,
        string destinationPath,
        IReadOnlyList<string>? masterOrder = null,
        string? stringsFolder = null,
        bool noModKeySync = false)
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
        // A destination named other than plugin's ModKey needs this lifted.
        if (noModKeySync) writeBuilder = writeBuilder.NoModKeySync();

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
