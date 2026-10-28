using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Build;

/// <summary>A plugin whose source an init commits as it is given, not as decompile reads it, and the commit after the init
/// that repairs it.</summary>
internal sealed record RepairedInInit(RegisteredPlugin Plugin, PluginSource Flagged, TreeCommit Repaired);

/// <summary>Decompile and commit's init of a mod's repository, which decompile and repair makes too: each plugin through
/// the round-trip gate, every other file of the mod as an asset, in one commit, or nothing.</summary>
internal sealed class ModInit(
    ILogger logger, IPluginAdapter plugins, ISourceAdapter source, IModFolderRepository modFolders, PluginDecompiler decompiler)
{
    /// <summary>The repository of <paramref name="toCommit"/>, holding the source of each of the mod's
    /// plugins but <paramref name="leftOut"/>, and <paramref name="repair"/>'s two commits when given.
    /// Answers the plugins whose source it holds.</summary>
    internal async Task<ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>> InitAsync(
        LoadOrderSnapshot loadOrder, ModToDecompileAndCommit toCommit, IReadOnlySet<PluginAddress> leftOut,
        RepairedInInit? repair, Action<DecompileAndCommitPhase> setPhase, CancellationToken cancel)
    {
        var provided = ProvidedBy(loadOrder, toCommit.Name);
        if (provided.Count == 0)
        {
            return Refused(DecompileAndCommitRefusal.ModProvidesNoPlugin,
                $"'{toCommit.Name}' provides no plugin in the load order, so there is nothing to decompile and commit.");
        }

        var mod = (PluginProvider.FromMod)provided[0].Provider;

        if (source.IsSourceMod(toCommit.SourceFolder))
        {
            return Refused(DecompileAndCommitRefusal.AlreadyInitialized,
                $"'{toCommit.SourceFolder}' already holds a repository. To put a plugin's source into its working tree, decompile it.");
        }

        // A .git with no main that Modbench did not make is someone else's, never written to (ADR-0003).
        if (source.HoldsAnotherRepository(toCommit.SourceFolder))
        {
            return Refused(DecompileAndCommitRefusal.AlreadyInitialized,
                $"'{toCommit.SourceFolder}' already holds a repository with no main branch, made outside Modbench.");
        }

        var verified = new List<(RegisteredPlugin Plugin, PluginSource Source)>();
        var refused = new List<ItemRefused<PluginAddress, DecompileAndCommitRefusal>>();
        foreach (var plugin in provided.Where(plugin => !leftOut.Contains(plugin.Key)))
        {
            cancel.ThrowIfCancellationRequested();
            if (repair is { } repaired && PluginAddress.Comparer.Equals(repaired.Plugin.Key, plugin.Key))
            {
                verified.Add((plugin, repaired.Flagged));
                continue;
            }
            setPhase(DecompileAndCommitPhase.Parsing);
            var decompiled = await decompiler.DecompileAsync(
                loadOrder, plugin, mod.Folder, onParsed: () => setPhase(DecompileAndCommitPhase.Serializing), cancel);
            if (decompiled.Source is { } read)
            {
                verified.Add((plugin, read));
            }
            else
            {
                refused.Add(new ItemRefused<PluginAddress, DecompileAndCommitRefusal>(
                    plugin.Key,
                    decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                        ? DecompileAndCommitRefusal.MissingLocalizationStrings
                        : DecompileAndCommitRefusal.RoundTripFailed,
                    decompiled.Message));
            }
        }

        if (refused.Count > 0)
        {
            var cause = refused.Select(r => r.Refusal).Distinct().ToList() is [var shared] ? shared : DecompileAndCommitRefusal.PluginsRefused;
            return Refused(cause, string.Join('\n', refused.Select(r => r.Message)));
        }

        setPhase(DecompileAndCommitPhase.ReadingFiles);
        Manifest manifest;
        List<Asset> assets;
        try
        {
            var held = modFolders.ReadManifest(mod.Folder);
            if (held?.Packages.OfType<ManifestPackage.GameFolder>().FirstOrDefault() is { } gameFolder)
            {
                return Refused(DecompileAndCommitRefusal.ManifestNamesGameFolder,
                    $"'{mod.Name}' was not initialized: its manifest names the game folder '{gameFolder.Name}' as a package, and a source mod's build reads only installation files, so its files would become assets in git.");
            }
            (manifest, assets) = ContentsOf(held, mod, toCommit, provided, loadOrder.GameRelease);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            return Refused(DecompileAndCommitRefusal.ModFilesUnreadable,
                $"'{mod.Name}' was not initialized: a file of its folder could not be read: {ex.Message}");
        }

        setPhase(DecompileAndCommitPhase.Committing);
        // modlist-repository.md, The manifest, story 1: a source mod's manifest is in its repository instead, so the one in its
        // folder goes before the commit, and comes back when the commit fails.
        SpelledManifest? removed;
        try
        {
            removed = modFolders.RemoveManifest(mod.Folder, toCommit.SourceFolder);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Refused(DecompileAndCommitRefusal.CommitFailed, $"'{mod.Name}' was not initialized: the manifest in its folder could not be removed: {ex.Message}");
        }

        if (Commit(toCommit.SourceFolder, verified, manifest, assets, repair) is { } failure)
        {
            logger.LogWarning("Refused to decompile and commit {Mod}: {Reason}", mod.Name, failure.Reason);
            return Refused(DecompileAndCommitRefusal.CommitFailed, $"'{mod.Name}' was not initialized: {failure.Reason}{PutBack(mod.Folder, removed)}");
        }

        return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Landed([.. verified.Select(v => v.Plugin.Key)]);
    }

    private string PutBack(string modFolder, SpelledManifest? removed)
    {
        if (removed is null) return "";
        try
        {
            modFolders.WriteFile(modFolder, removed.Name, content => content.Write(removed.Text));
            return "";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return $"; the manifest its folder held, '{removed.Name}', could not be put back: {ex.Message}";
        }
    }

    private static List<RegisteredPlugin> ProvidedBy(LoadOrderSnapshot loadOrder, string modName) =>
        [.. loadOrder.Plugins.Where(plugin => plugin.Provider is PluginProvider.FromMod mod
            && string.Equals(mod.Name, modName, StringComparison.OrdinalIgnoreCase))];

    private static ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>> Refused(DecompileAndCommitRefusal refusal, string message) =>
        ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(refusal, message);

    // plugins.md, Decompile and commit, story 2: the installation file, a step and compile each make files; the rest are assets.
    // The manifest is in the form a build writes.
    private (Manifest Manifest, List<Asset> Assets) ContentsOf(
        Manifest? held, PluginProvider.FromMod mod, ModToDecompileAndCommit toCommit, List<RegisteredPlugin> provided, GameRelease release)
    {
        var all = modFolders.Files(mod.Folder, toCommit.MetadataFiles.ToHashSet(StringComparer.Ordinal), statCache: null).Files;
        var paths = all.Select(file => file.Path).ToList();
        var compiled = provided.SelectMany(plugin => plugins.WrittenByCompile(plugin, paths, release)).ToHashSet(StringComparer.Ordinal);
        var installationFile = toCommit.InstallationFile is { } named ? (modFolders.InstallationFileName(named.Path), named) : ((string, InstallationFile)?)null;
        var recorded = new ManifestBuilder(installationFile, gameFolder: null, downloadedFiles: []).Manifest([.. all.Where(file => !compiled.Contains(file.Path))], toCommit.Version, held);
        var taken = recorded.Files.Select(line => recorded.BytesOf(line) is FileBytes.InInstallationFile yielded ? line with { Package = yielded.Name } : null).OfType<ManifestFile>().ToList();
        var madeByStep = recorded.Files.Where(line => line.Entry is PackageEntry.MadeByStep).ToList();
        var notTheBuilds = taken.Concat(madeByStep).Select(line => line.Path).ToHashSet(StringComparer.Ordinal);
        var made = all.Where(file => !notTheBuilds.Contains(file.Path)).ToList();
        var repository = new ManifestPackage.SourceRepository(modFolders.FolderName(toCommit.SourceFolder), IsSubmodule: false);
        var manifest = recorded with
        {
            Packages = [repository, .. recorded.Packages],
            Files = [.. made.Select(file => new ManifestFile(file.Path, new PackageEntry.Held())), .. taken, .. madeByStep],
            Output = modFolders.FolderName(mod.Folder),
            Version = toCommit.Version,
        };
        return (manifest, [.. made.Where(file => !compiled.Contains(file.Path)).Select(file => new Asset(file.Path, () => modFolders.OpenFile(mod.Folder, file.Path)))]);
    }

    // The adapter writes nothing when any of it fails (plugins.md, Decompile and commit, story 5).
    private SourceFailure? Commit(
        string sourceFolder, List<(RegisteredPlugin Plugin, PluginSource Source)> verified, Manifest manifest,
        List<Asset> assets, RepairedInInit? repair)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Initializing {SourceFolder} with {PluginCount} plugin(s), {FileCount} source files and {AssetCount} asset(s)",
                sourceFolder, verified.Count, verified.Sum(v => v.Source.Files.Count), assets.Count);
        }

        return source.Init(sourceFolder, modFolders.SpellSourceManifest(manifest),
            [.. verified.Select(v => (v.Source.Files, new DecompiledPlugin(v.Plugin.Key, v.Source.BinarySha256)))], assets,
            repair is { } repaired ? (repaired.Plugin.Key, repaired.Repaired) : null);
    }
}
