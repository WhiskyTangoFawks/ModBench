using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Build;

/// <summary>A plugin whose source an init commits as <paramref name="Baseline"/>, not as decompile reads it, the binary
/// <paramref name="OriginalSha256"/> names, and the commit after the init that repairs it.</summary>
internal sealed record RepairedInInit(RegisteredPlugin Plugin, IReadOnlyList<TreeFile> Baseline, string OriginalSha256, TreeCommit Repaired);

/// <summary>Decompile and commit's init of a mod's repository, which decompile and repair makes too: each plugin through
/// the round-trip gate, the assets and its build file (ADR-0016), in one commit, or nothing.</summary>
internal sealed class ModInit(ILogger logger, ISourceAdapter source, IModFolderRepository modFolders, PluginDecompiler decompiler)
{
    /// <summary>The repository of <paramref name="toCommit"/>, holding the source of each of the mod's plugins but
    /// <paramref name="leftOut"/>, a repaired one's as its baseline, then its repair. Answers the plugins it holds.</summary>
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

        if (source.IsSourceMod(toCommit.Repository.SourceFolder))
        {
            return Refused(DecompileAndCommitRefusal.AlreadyInitialized,
                $"'{toCommit.Repository.SourceFolder}' already holds a repository. To put a plugin's source into its working tree, decompile it.");
        }

        // A .git with no main that Modbench did not make is someone else's, never written to (ADR-0003).
        if (source.HoldsAnotherRepository(toCommit.Repository.SourceFolder))
        {
            return Refused(DecompileAndCommitRefusal.AlreadyInitialized,
                $"'{toCommit.Repository.SourceFolder}' already holds a repository with no main branch, made outside Modbench.");
        }

        var verified = new List<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)>();
        var refused = new List<ItemRefused<PluginAddress, DecompileAndCommitRefusal>>();
        foreach (var plugin in provided.Where(plugin => !leftOut.Contains(plugin.Key)))
        {
            cancel.ThrowIfCancellationRequested();
            if (repair is { } repaired && PluginAddress.Comparer.Equals(repaired.Plugin.Key, plugin.Key))
            {
                verified.Add((repaired.Baseline, new DecompiledPlugin(plugin.Key, repaired.OriginalSha256)));
                continue;
            }
            setPhase(DecompileAndCommitPhase.Parsing);
            var decompiled = await decompiler.DecompileAsync(
                loadOrder, plugin, mod.Folder, onParsed: () => setPhase(DecompileAndCommitPhase.Serializing), cancel);
            if (decompiled.Source is { } read)
            {
                verified.Add((read.Files, new DecompiledPlugin(plugin.Key, read.BinarySha256)));
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

        setPhase(DecompileAndCommitPhase.Committing);
        List<Asset> assets = [.. toCommit.Repository.Assets.Select(path => new Asset(path, () => modFolders.OpenFile(mod.Folder, path)))];
        if (Commit(toCommit.Repository.SourceFolder, verified, toCommit.Repository.BuildFile, assets, repair, toCommit.Repository.Manifest) is { } failure)
        {
            logger.LogWarning("Refused to decompile and commit {Mod}: {Reason}", mod.Name, failure.Reason);
            return Refused(DecompileAndCommitRefusal.CommitFailed, $"'{mod.Name}' was not initialized: {failure.Reason}");
        }

        return ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Landed([.. verified.Select(v => v.Plugin.Address)]);
    }

    private static List<RegisteredPlugin> ProvidedBy(LoadOrderSnapshot loadOrder, string modName) =>
        [.. loadOrder.Plugins.Where(plugin => plugin.Provider is PluginProvider.FromMod mod
            && string.Equals(mod.Name, modName, StringComparison.OrdinalIgnoreCase))];

    private static ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>> Refused(DecompileAndCommitRefusal refusal, string message) =>
        ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refused(refusal, message);

    // The adapter writes nothing when any of it fails (plugins.md, Decompile and commit, story 5).
    private SourceFailure? Commit(
        string sourceFolder, List<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> verified, byte[] buildFile,
        List<Asset> assets, RepairedInInit? repair, RootFile? manifest)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Initializing {SourceFolder} with {PluginCount} plugin(s), {FileCount} source files and {AssetCount} asset(s)",
                sourceFolder, verified.Count, verified.Sum(v => v.Tree.Count), assets.Count);
        }

        return source.Init(sourceFolder, buildFile, verified, assets, repair is { } repaired ? (repaired.Plugin.Key, repaired.Repaired) : null, manifest);
    }
}
