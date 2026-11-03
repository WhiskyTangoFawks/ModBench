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

/// <summary>Version in git's init of a mod's source folder, which decompile and repair makes too: each plugin through
/// the round-trip gate, the assets and its build file (ADR-0016), all written, or nothing.</summary>
internal sealed class ModInit(ILogger logger, ISourceAdapter source, IModFolderRepository modFolders, PluginDecompiler decompiler)
{
    /// <summary>The repository of <paramref name="toCommit"/>, holding the source of each of the mod's plugins but
    /// <paramref name="leftOut"/>, a repaired one's as its baseline, then its repair. Answers the plugins it holds.</summary>
    internal async Task<ItemAnswer<VersionInGitRefusal, IReadOnlyList<PluginAddress>>> InitAsync(
        LoadOrderSnapshot loadOrder, ModToVersionInGit toCommit, IReadOnlySet<PluginAddress> leftOut,
        RepairedInInit? repair, Action<VersionInGitPhase> setPhase, CancellationToken cancel)
    {
        var provided = ProvidedBy(loadOrder, toCommit.Name);

        if (source.IsSourceMod(toCommit.Repository.SourceFolder))
        {
            return Refused(VersionInGitRefusal.AlreadyInitialized,
                $"'{toCommit.Repository.SourceFolder}' is already a source mod's source folder. To put a plugin's source into its working tree, decompile it.");
        }

        // A .git with no main that Modbench did not make is someone else's, never written to (ADR-0003).
        if (source.HoldsAnotherRepository(toCommit.Repository.SourceFolder))
        {
            return Refused(VersionInGitRefusal.AlreadyInitialized,
                $"'{toCommit.Repository.SourceFolder}' already holds a repository with no main branch, made outside Modbench.");
        }

        var verified = new List<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)>();
        var refused = new List<ItemRefused<PluginAddress, VersionInGitRefusal>>();
        foreach (var plugin in provided.Where(plugin => !leftOut.Contains(plugin.Key)))
        {
            cancel.ThrowIfCancellationRequested();
            if (repair is { } repaired && PluginAddress.Comparer.Equals(repaired.Plugin.Key, plugin.Key))
            {
                verified.Add((repaired.Baseline, new DecompiledPlugin(plugin.Key, repaired.OriginalSha256)));
                continue;
            }
            setPhase(VersionInGitPhase.Parsing);
            var decompiled = await decompiler.DecompileAsync(
                loadOrder, plugin, toCommit.ModFolder, onParsed: () => setPhase(VersionInGitPhase.Serializing), cancel);
            if (decompiled.Source is { } read)
            {
                verified.Add((read.Files, new DecompiledPlugin(plugin.Key, read.BinarySha256)));
            }
            else
            {
                refused.Add(new ItemRefused<PluginAddress, VersionInGitRefusal>(
                    plugin.Key,
                    decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                        ? VersionInGitRefusal.MissingLocalizationStrings
                        : VersionInGitRefusal.RoundTripFailed,
                    decompiled.Message));
            }
        }

        if (refused.Count > 0)
        {
            var cause = refused.Select(r => r.Refusal).Distinct().ToList() is [var shared] ? shared : VersionInGitRefusal.PluginsRefused;
            return Refused(cause, string.Join('\n', refused.Select(r => r.Message)));
        }

        setPhase(VersionInGitPhase.Committing);
        List<FileToCopy> assets = [.. toCommit.Repository.Assets.Select(path => new FileToCopy(path, () => modFolders.OpenFile(toCommit.ModFolder, path)))];
        if (Commit(toCommit, verified, assets, repair) is { } failure)
        {
            logger.LogWarning("Refused to version {Mod} in git: {Reason}", toCommit.Name, failure.Reason);
            return Refused(VersionInGitRefusal.CommitFailed, $"'{toCommit.Name}' was not put under git: {failure.Reason}");
        }

        return ItemAnswer<VersionInGitRefusal, IReadOnlyList<PluginAddress>>.Landed([.. verified.Select(v => v.Plugin.Address)]);
    }

    private static List<RegisteredPlugin> ProvidedBy(LoadOrderSnapshot loadOrder, string modName) =>
        [.. loadOrder.Plugins.Where(plugin => plugin.Provider is PluginProvider.FromMod mod
            && string.Equals(mod.Name, modName, StringComparison.OrdinalIgnoreCase))];

    private static ItemAnswer<VersionInGitRefusal, IReadOnlyList<PluginAddress>> Refused(VersionInGitRefusal refusal, string message) =>
        ItemAnswer<VersionInGitRefusal, IReadOnlyList<PluginAddress>>.Refused(refusal, message);

    // The adapter writes nothing when any of it fails (plugins.md, Version in git, story 5).
    private SourceFailure? Commit(
        ModToVersionInGit toCommit, List<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> verified, List<FileToCopy> assets, RepairedInInit? repair)
    {
        var made = toCommit.Repository;
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Initializing {SourceFolder} in {Repository} with {PluginCount} plugin(s), {FileCount} source files and {AssetCount} asset(s)",
                made.SourceFolder, toCommit.In, verified.Count, verified.Sum(v => v.Tree.Count), assets.Count);
        }

        return source.Init(
            made.SourceFolder, made.BuildFile, verified, assets, toCommit.Commit, repair is { } repaired ? (repaired.Plugin.Key, repaired.Repaired) : null,
            made.Manifest, made.Ignored, toCommit.In);
    }
}
