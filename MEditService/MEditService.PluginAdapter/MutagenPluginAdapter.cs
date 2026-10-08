using System.Security.Cryptography;
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
            var documents = ModDocuments.Of(loaded.Getter, new PluginRecordBytes(modPath, gameRelease), schemas, loaded);
            loaded = null;
            return documents;
        }
        finally
        {
            loaded?.Dispose();
        }
    }

    public IPluginRecordLookup OpenRecordLookup(
        RegisteredPlugin plugin,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var modPath = new ModPath(plugin.Path);
        ILoadedMod? loaded = OpenForRead(modPath, gameRelease);
        try
        {
            var lookup = ModDocuments.LookupOf(loaded.Getter, new PluginRecordBytes(modPath, gameRelease), schemas, loaded);
            loaded = null;
            return lookup;
        }
        finally
        {
            loaded?.Dispose();
        }
    }

    public bool GameFolderExists(string gameFolder) => Directory.Exists(gameFolder);

    // FileMode.Open, FileAccess.Read, FileShare.Read: what File.OpenRead gives, and what every
    // read below opens the same file with, so this answers for the read that follows it.
    public bool CanRead(RegisteredPlugin plugin)
    {
        try
        {
            using (File.OpenRead(plugin.Path)) return true;
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
        LoadOrderSnapshot loadOrder,
        RegisteredPlugin compiled,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys)
    {
        // One mod per filename, because that is what a link cache can hold: the plugin being compiled
        // stands in for its own filename, at whatever slot the load order gives that name.
        // A copy a line names stands for its filename; a plugin with no line is found after them.
        var loaded = loadOrder.LoadOrderIndex(compiled.Key) is null
            ? loadOrder.JudgedCopies().Concat(loadOrder.InJudgedOrder())
            : loadOrder.Active;
        var files = loaded
            .Select(plugin => SameFile(plugin, compiled) ? compiled : plugin)
            .Append(compiled)
            .DistinctBy(plugin => plugin.Name, StringComparer.OrdinalIgnoreCase)
            .Select(plugin => new ModPath(plugin.Path))
            .ToList();
        return LoadOrderLinks.Targets(files, loadOrder.GameRelease, schemas, formKeys);
    }

    private static bool SameFile(RegisteredPlugin plugin, RegisteredPlugin other) =>
        plugin.Name.Equals(other.Name, StringComparison.OrdinalIgnoreCase);

    public Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        RecordTextCodec codec,
        GameRelease gameRelease,
        CancellationToken cancel = default) =>
        PluginTrees.ReadTreeAsync(files, codec, gameRelease, cancel);

    public Task WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder,
        CancellationToken cancel = default) =>
        PluginTrees.WriteFromTreeAsync(files, destinationPath, masterOrder, cancel);

    public Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceOfAsync(
        RegisteredPlugin plugin, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default) =>
        PluginTrees.ReadAsync(
            new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), plugin.Name, gameRelease, strings, cancel);

    public string? DivergenceFrom(
        string pluginFileName, string pluginFilePath, string recompiledPath, GameRelease gameRelease, PluginStrings strings) =>
        PluginTrees.DivergenceBetween(
            new ModPath(ModKey.FromFileName(pluginFileName), pluginFilePath), recompiledPath, gameRelease, strings)?.Describe();

    public async Task<PluginByteComparison> CompareBytesAsync(
        string originalPath, string recompiledPath, CancellationToken cancel = default)
    {
        var originalBytes = await File.ReadAllBytesAsync(originalPath, cancel);
        var recompiledBytes = await File.ReadAllBytesAsync(recompiledPath, cancel);
        if (originalBytes.AsSpan().SequenceEqual(recompiledBytes))
            return new PluginByteComparison(Identical: true);

        if (PluginBinaryWalk.FindFirstSubrecordLoss(originalBytes, recompiledBytes) is not { } loss)
            return new PluginByteComparison(Identical: false);

        var cause = MalformedPluginScan.Scan(originalBytes).FirstOrDefault(d =>
            d.Anchor?.StartsWith($"{loss.RecordType} {loss.FormId:X8}", StringComparison.Ordinal) == true);
        return new PluginByteComparison(Identical: false, loss, cause);
    }

    internal static IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        => ModFactory.ImportSetter(modPath, gameRelease, ReadParameters(strings));

    private static BinaryReadParameters? ReadParameters(PluginStrings? strings) =>
        strings is { } named ? LocalizedStrings.ForRead(named) : null;

    internal static IMod CreateEmpty(ModKey modKey, GameRelease gameRelease)
        => ModFactory.Activator(modKey, gameRelease);

    private static string HashOf(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    public string PathOfEmpty(ModKey modKey, string folder) => Path.Combine(folder, modKey.FileName.String);

    public EmptyPluginTakeBack TakeBackEmpty(ModKey modKey, string folder, string written)
    {
        var path = PathOfEmpty(modKey, folder);
        if (!File.Exists(path)) return EmptyPluginTakeBack.Gone;
        if (HashOf(File.ReadAllBytes(path)) != written)
            return EmptyPluginTakeBack.Changed;

        File.Delete(path);
        return EmptyPluginTakeBack.TakenBack;
    }

    public async Task<EmptyPluginCreated> CreateAndWriteAsync(
        ModKey modKey, string folder, GameRelease gameRelease)
    {
        var destinationPath = PathOfEmpty(modKey, folder);
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
            var written = HashOf(await File.ReadAllBytesAsync(tempPath));
            File.Move(tempPath, destinationPath, overwrite: false);
            return new EmptyPluginCreated(EmptyPluginWrite.Written, written);
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

    /// <summary>Bytes written in place; the temp file and rename are <see cref="PluginWriter"/>'s. A
    /// mod read from a source tree has no header masters (ADR-0008), so it needs
    /// <paramref name="masterOrder"/>.</summary>
    internal static async Task WriteAsync(
        IMod plugin,
        string destinationPath,
        IReadOnlyList<string>? masterOrder = null,
        string? stringsFolder = null,
        bool noModKeySync = false)
    {
        var toPath = plugin.BeginWrite.ToPath(destinationPath);
        // Mutagen's default resets the Next Object ID to one past the highest FormID, which would
        // hand a deleted record's FormKey out again (plugins.md, Create record, story 2).
        var writeBuilder = (masterOrder is null
                ? toPath.WithLoadOrderFromHeaderMasters()
                : toPath.WithLoadOrder(masterOrder.Select(name => ModKey.FromFileName(name))))
            .WithNoDataFolder()
            .NoNextFormIDProcessing();
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

        await writeBuilder.WriteAsync();
    }

    private sealed class LoadedMod(IModDisposeGetter inner) : ILoadedMod
    {
        public IModGetter Getter => inner;
        public void Dispose() => inner.Dispose();
    }
}
