using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Mutagen.Bethesda.Strings.DI;

namespace MEditService.Core.PluginAdapter;

/// <summary>The one implementation: Mutagen's own mod factory and write builder, reached by the
/// release the caller passed and never by a game this code names.</summary>
public sealed class MutagenPluginAdapter : IPluginAdapter
{
    /// <summary>For the gestures with no seam of their own — create, absorb, keep, Track and the
    /// prepared save — which need the adapter without a constructor to inject it through.</summary>
    public static readonly IPluginAdapter Instance = new MutagenPluginAdapter();

    public ILoadedMod OpenForRead(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        => new LoadedMod(ModFactory.ImportGetter(modPath, gameRelease, ReadParameters(strings)));

    public IPluginDocuments OpenDocuments(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null)
    {
        var loaded = OpenForRead(modPath, gameRelease, strings);
        return ModDocuments.Of(loaded.Getter, schemas, loaded);
    }

    public IPluginRecordLookup OpenRecordLookup(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var loaded = OpenForRead(modPath, gameRelease);
        return ModDocuments.LookupOf(loaded.Getter, schemas, loaded);
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
        LoadOrderLinks.Targets(this, loadOrder, gameRelease, schemas, formKeys);

    public bool LinksTo(ModPath modPath, GameRelease gameRelease, FormKey target, FormKey? itself)
    {
        using var loaded = OpenForRead(modPath, gameRelease);
        return OpenedPlugins.LinksTo(loaded.Getter, modPath.ModKey.FileName.String, target, itself);
    }

    public IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null)
        => ModFactory.ImportSetter(modPath, gameRelease, ReadParameters(strings));

    private static BinaryReadParameters? ReadParameters(PluginStrings? strings) =>
        strings is { } named ? LocalizedStrings.ForRead(named) : null;

    public IMod CreateEmpty(ModKey modKey, GameRelease gameRelease)
        => ModFactory.Activator(modKey, gameRelease);

    public async Task CreateAndWriteAsync(
        ModKey modKey, string destinationPath, GameRelease gameRelease, bool smallMaster)
    {
        // Never-assume-exclusive-ownership: the destination may be a mod folder nothing has written
        // into yet — a brand-new mod, or overwrite/ before its first file.
        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
        if (File.Exists(destinationPath))
            throw new IOException($"Plugin file already exists: {Path.GetFileName(destinationPath)}");

        var plugin = CreateEmpty(modKey, gameRelease);
        if (smallMaster) plugin.IsSmallMaster = true;
        await WriteAsync(plugin, destinationPath);
    }

    public async Task WriteAsync(
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

        // Mutagen's default StringsWriter derives its folder from the write path, so a caller writing
        // to a temp file needs its own to keep strings under the same temp discipline.
        if (stringsFolder != null && plugin.UsingLocalization)
        {
            writeBuilder = writeBuilder.WithStringsWriter(new StringsWriter(
                plugin.GameRelease, plugin.ModKey,
                writeDirectory: stringsFolder,
                encodingProvider: MutagenEncoding.Default));
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
