using System.Security.Cryptography;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
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
public sealed class MutagenPluginAdapter(TimeProvider timeProvider) : IPluginAdapter
{
    private readonly PluginFileHashes _hashes = new(timeProvider);

    internal static ILoadedMod OpenForRead(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null, LoadOrderSnapshot? loadOrder = null)
        => new LoadedMod(ModFactory.ImportGetter(modPath, gameRelease, ReadParameters(modPath, gameRelease, strings, loadOrder)));

    // The header is read with the open: a header Mutagen cannot read is the open's failure, not a
    // throw out of the ingest that follows.
    public Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath,
        LoadOrderSnapshot loadOrder,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        Opened<IPluginDocuments>(modPath, strings, loadOrder, loaded =>
        {
            var documents = new MutagenModDocuments(loaded.Getter, new PluginRecordBytes(modPath, loadOrder), schemas, loaded);
            _ = documents.Header;
            return documents;
        });

    public Answer<IPluginRecords, PluginFailure> OpenRecordLookup(
        RegisteredPlugin plugin,
        LoadOrderSnapshot loadOrder,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var modPath = new ModPath(plugin.Path);
        return Opened<IPluginRecords>(modPath, new PluginStrings(Path.GetDirectoryName(plugin.Path), loadOrder.DataFolderPath), loadOrder, loaded =>
            new ModRecordLookup(loaded.Getter, new PluginRecordBytes(modPath, loadOrder), schemas, loaded));
    }

    // The open passes to what its result holds; until it has, a failure disposes it here.
    private static Answer<T, PluginFailure> Opened<T>(
        ModPath modPath, PluginStrings? strings, LoadOrderSnapshot loadOrder, Func<ILoadedMod, T> holding)
    {
        ILoadedMod? loaded = null;
        try
        {
            return PluginFailure.Answer(() => loaded = OpenForRead(modPath, loadOrder.GameRelease, strings, loadOrder))
                .Then(mod => PluginFailure.Answer(() => strings is { } named
                        ? LocalizedStrings.FindMissingStringsFile(mod.Getter, modPath.ModKey.FileName, named, loadOrder.GameRelease)
                        : null)
                    .Then(missing => missing is { } file
                        ? new PluginFailure.MissingStrings(file)
                        : PluginFailure.Answer(() =>
                        {
                            var held = holding(mod);
                            loaded = null;
                            return held;
                        })));
        }
        finally
        {
            loaded?.Dispose();
        }
    }

    public bool GameFolderExists(string gameFolder) => Directory.Exists(gameFolder);

    public bool Exists(string pluginPath) => File.Exists(pluginPath);

    public string? HashOf(string pluginPath) => _hashes.Of(pluginPath);

    public void KeepHashesOf(IReadOnlySet<string> pluginPaths) => _hashes.Keep(pluginPaths);

    public Answer<FileClaim, PluginFailure> ClaimOf(string pluginPath, GameRelease gameRelease) => PluginBinaryHash.ClaimOfFile(pluginPath, gameRelease);

    public Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
        ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings? strings = null) =>
        Opened(modPath, strings, loadOrder, loaded =>
        {
            using (loaded)
            {
                var name = modPath.ModKey.FileName.String;
                // Mutagen's game-agnostic getter carries no raw header flags and names no blueprint bit, so
                // only a game with blueprint plugins reads its header a second time.
                var isBlueprint = PluginFlagPredicates.HasBlueprintPlugins(loadOrder.GameRelease)
                    && PluginFlagPredicates.IsBlueprint(loaded.Getter, name, ModHeaderFrame.FromPath(modPath, loadOrder.GameRelease).Flags);
                return OpenedPlugins.ContentIn(loaded.Getter, name, isBlueprint);
            }
        });

    public LinkAnswers LinkTargets(
        LoadOrderSnapshot loadOrder,
        RegisteredPlugin compiled,
        IReadOnlyCollection<string> formKeys)
    {
        var loaded = loadOrder.LoadOrderIndex(compiled.Key) is null ? MasterStyles.CopyOfEachFilename(loadOrder) : loadOrder.Active;

        // One mod per filename, because that is what a link cache can hold: the plugin being compiled
        // stands in for its own filename, at whatever line the load order gives that name.
        var files = loaded
            .Select(plugin => SameFile(plugin, compiled) ? compiled : plugin)
            .Append(compiled)
            .DistinctBy(plugin => plugin.Name, StringComparer.OrdinalIgnoreCase)
            .Select(plugin => new ModPath(plugin.Path))
            .ToList();
        return LoadOrderLinks.Targets(files, loadOrder, formKeys);
    }

    private static bool SameFile(RegisteredPlugin plugin, RegisteredPlugin other) =>
        plugin.Name.Equals(other.Name, StringComparison.OrdinalIgnoreCase);

    public Task<Answer<CompiledTree, PluginFailure>> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        GameRelease gameRelease,
        CancellationToken cancel = default) =>
        PluginTrees.ReadTreeAsync(files, gameRelease, cancel);

    public Task<Answer<string, PluginFailure>> WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder, GameRelease gameRelease,
        CancellationToken cancel = default) =>
        PluginTrees.WriteFromTreeAsync(files, destinationPath, masterOrder, gameRelease, cancel);

    public Task<Answer<PluginSource, PluginFailure>> ReadSourceOfAsync(
        RegisteredPlugin plugin, LoadOrderSnapshot loadOrder, PluginStrings strings, CancellationToken cancel = default) =>
        PluginTrees.ReadAsync(new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), plugin.Name, loadOrder, strings, cancel);

    public Answer<string?, PluginFailure> DivergenceFrom(
        string pluginFileName, string pluginFilePath, string recompiledPath, LoadOrderSnapshot loadOrder, PluginStrings strings) =>
        PluginFailure.Answer(() => PluginTrees.DivergenceBetween(
            new ModPath(ModKey.FromFileName(pluginFileName), pluginFilePath), recompiledPath, loadOrder, strings)?.Describe());

    public Task<Answer<PluginByteComparison, PluginFailure>> CompareBytesAsync(
        string originalPath, string recompiledPath, LoadOrderSnapshot loadOrder, CancellationToken cancel = default) =>
        PluginFailure.AnswerAsync(async () =>
        {
            var originalBytes = await File.ReadAllBytesAsync(originalPath, cancel);
            var recompiledBytes = await File.ReadAllBytesAsync(recompiledPath, cancel);
            if (originalBytes.AsSpan().SequenceEqual(recompiledBytes))
                return new PluginByteComparison(Identical: true);

            var plugin = ModKey.FromFileName(Path.GetFileName(originalPath));
            var pairs = PluginBinaryWalk.PairByFormKey(
                originalBytes, PluginBinaryWalk.MastersOf(new ModPath(plugin, originalPath), loadOrder),
                recompiledBytes, PluginBinaryWalk.MastersOf(new ModPath(plugin, recompiledPath), loadOrder), loadOrder.GameRelease);
            var deletedRecordEmptied = PluginBinaryWalk.FirstEmptiedDeletedRecord(pairs) is { } emptied
                ? $"{emptied.Original.RecordType} {emptied.FormKey}"
                : null;
            if (PluginBinaryWalk.FindFirstSubrecordLoss(pairs) is not { } loss)
                return new PluginByteComparison(Identical: false, DeletedRecordEmptied: deletedRecordEmptied);

            var cause = MalformedPluginScan.Scan(originalBytes, loadOrder.GameRelease).FirstOrDefault(d =>
                d.Anchor?.StartsWith($"{loss.RecordType} {loss.FormId:X8}", StringComparison.Ordinal) == true);
            return new PluginByteComparison(Identical: false, loss, cause, deletedRecordEmptied);
        });

    internal static IMod OpenForWrite(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null, LoadOrderSnapshot? loadOrder = null)
        => ModFactory.ImportSetter(modPath, gameRelease, ReadParameters(modPath, gameRelease, strings, loadOrder));

    private static BinaryReadParameters? ReadParameters(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings, LoadOrderSnapshot? loadOrder)
    {
        var read = strings is { } named ? LocalizedStrings.ForRead(named, modPath.ModKey, gameRelease) : null;
        return MasterStyles.Of(modPath, loadOrder) is { } styles
            ? (read ?? new BinaryReadParameters()) with { MasterFlagsLookup = styles }
            : read;
    }

    internal static IMod CreateEmpty(ModKey modKey, GameRelease gameRelease)
        => ModFactory.Activator(modKey, gameRelease);

    private static string HashOf(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    public string PathOfEmpty(ModKey modKey, string folder) => Path.Combine(folder, modKey.FileName.String);

    public Answer<EmptyPluginTakeBack, PluginFailure> TakeBackEmpty(ModKey modKey, string folder, string written) =>
        PluginFailure.Answer(() =>
        {
            var path = PathOfEmpty(modKey, folder);
            if (!File.Exists(path)) return EmptyPluginTakeBack.Gone;
            if (HashOf(File.ReadAllBytes(path)) != written)
                return EmptyPluginTakeBack.Changed;

            File.Delete(path);
            return EmptyPluginTakeBack.TakenBack;
        });

    public async Task<Answer<EmptyPluginCreated, PluginFailure>> CreateAndWriteAsync(
        ModKey modKey, string folder, GameRelease gameRelease)
    {
        var destinationPath = PathOfEmpty(modKey, folder);
        if (!Directory.Exists(folder)) return PluginAnswer.Of<EmptyPluginCreated>(EmptyPluginWrite.FolderGone);
        if (File.Exists(destinationPath)) return PluginAnswer.Of<EmptyPluginCreated>(EmptyPluginWrite.FileExists);

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
            return PluginAnswer.Of(new EmptyPluginCreated(EmptyPluginWrite.Written, written));
        }
        catch (IOException) when (File.Exists(destinationPath))
        {
            return PluginAnswer.Of<EmptyPluginCreated>(EmptyPluginWrite.FileExists);
        }
        catch (DirectoryNotFoundException) when (!Directory.Exists(folder))
        {
            return PluginAnswer.Of<EmptyPluginCreated>(EmptyPluginWrite.FolderGone);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new PluginFailure.Inaccessible(ex);
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
