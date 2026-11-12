using MEditService.Codec.Schema;
using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The decompile and repair gesture's handler (source.md, Decompile and repair): a malformed plugin into
/// its mod's plugin source as two commits, the plugin as it was with each malformed record a placeholder, then repaired.</summary>
public sealed class DecompileAndRepairPluginHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly IPluginAdapter _adapter;
    private readonly ISourceAdapter _source;
    private readonly ILogger _logger;
    private readonly PluginRepairer _repairer;
    private readonly ModInit _init;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal DecompileAndRepairPluginHandler(
        LoadOrderHolder loadOrder, IPluginAdapter adapter, ISourceAdapter source, IModFolderRepository modFolders,
        SchemaReflector schemaReflector, ILogger<DecompileAndRepairPluginHandler> logger)
    {
        var decompiler = new PluginDecompiler(logger, adapter, source, schemaReflector);
        (_loadOrder, _adapter, _source, _logger) = (loadOrder, adapter, source, logger);
        _repairer = new PluginRepairer(adapter, decompiler);
        _init = new ModInit(logger, source, modFolders, decompiler);
    }

    /// <summary>A source with working-tree changes is refused, listing them, unless <paramref name="force"/> waives them.</summary>
    public async Task<Answer<DecompileAndRepairResult, SelectionRefusal<DecompileAndRepairRefusal>>> DecompileAndRepairAsync(
        IReadOnlyList<PluginToRepair> plugins, bool force, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return new SelectionRefusal<DecompileAndRepairRefusal>(DecompileAndRepairRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var named = plugins.Select(item => item.Plugin).ToHashSet(PluginAddress.Comparer);
        var targets = plugins.ToDictionary(
            item => item.Plugin,
            item => RepairTarget.Of(_repairer, loadOrder, item.Plugin, named,
                mod => (mod.SourceFolder ?? item.SourceFolder?.Path) is { } folder && _source.IsSourceMod(folder)),
            PluginAddress.Comparer);
        var repairedHere = targets.Where(target => target.Value is RepairTarget.Diagnosed).Select(target => target.Key).ToHashSet(PluginAddress.Comparer);
        var leftOutOfANewSourceFolder = new HashSet<PluginAddress>(PluginAddress.Comparer);
        var heldByANewSourceFolder = new HashSet<PluginAddress>(PluginAddress.Comparer);
        var repaired = await ItemWrite.OverAsync(_source, plugins, SamePlugin.Instance, DecompileAndRepairRefusal.GitUnavailable, item =>
        {
            cancel.ThrowIfCancellationRequested();
            return RepairOneAsync(loadOrder, item, targets[item.Plugin], repairedHere, (leftOutOfANewSourceFolder, heldByANewSourceFolder), force, cancel);
        });
        return repaired.ToAnswer(
            landed => landed.Item.Plugin,
            refused => Explained(refused, leftOutOfANewSourceFolder, heldByANewSourceFolder),
            (applied, refused) => new DecompileAndRepairResult(applied, refused));
    }

    private static DecompileAndRepairRefused Explained(
        ItemRefused<PluginToRepair, DecompileAndRepairRefusal> refused, HashSet<PluginAddress> leftOut, HashSet<PluginAddress> held)
    {
        var plugin = refused.Item.Plugin;
        if (refused.Refusal == DecompileAndRepairRefusal.NotMalformed && held.Contains(plugin))
        {
            return new DecompileAndRepairRefused(plugin, DecompileAndRepairRefusal.DecompiledWithoutRepair,
                $"{plugin.Name} is not malformed, so it was decompiled without a repair, with the source folder made for its mod.");
        }
        var message = leftOut.Contains(plugin) ? $"{refused.Message} The source folder made for its mod holds no source for it." : refused.Message;
        return new DecompileAndRepairRefused(plugin, refused.Refusal, message);
    }

    private static ItemAnswer<DecompileAndRepairRefusal, NoOutcome> Refused(DecompileAndRepairRefusal refusal, string message) =>
        ItemAnswer<DecompileAndRepairRefusal, NoOutcome>.Refused(refusal, message);

    private async Task<ItemAnswer<DecompileAndRepairRefusal, NoOutcome>> RepairOneAsync(
        LoadOrderSnapshot loadOrder, PluginToRepair item, RepairTarget target, IReadOnlySet<PluginAddress> repairedHere,
        (HashSet<PluginAddress> LeftOut, HashSet<PluginAddress> Held) newSourceFolder, bool force, CancellationToken cancel)
    {
        if (target is RepairTarget.Refused(var targetRefusal, var targetMessage)) return Refused(targetRefusal, targetMessage);
        var (plugin, mod) = (RepairTarget.Diagnosed)target;
        var sourceFolder = mod.SourceFolder ?? item.SourceFolder?.Path;
        if (sourceFolder is null)
            return Refused(DecompileAndRepairRefusal.NoSourceFolder, $"{mod.Name} is not a source mod, and the request hands no source folder to make.");
        var inSourceMod = _source.IsSourceMod(sourceFolder);
        var repository = _source.OverFolder(mod with { SourceFolder = sourceFolder }, loadOrder.GameRelease);
        if (inSourceMod && !force && WorkingTreeCheck.Of(repository, plugin.Key, "decompile and repair") is { } workingTree)
        {
            return Refused(workingTree.Unreadable ? DecompileAndRepairRefusal.WorkingTreeStatusUnreadable : DecompileAndRepairRefusal.WorkingTreeChanges,
                workingTree.Message + " Nothing was written.");
        }

        if (!(await _repairer.DecompileRepairedAsync(loadOrder, plugin, mod.Folder, cancel)).Holds(out var repairedSource, out var failure))
            return RefusedAs(plugin, failure);
        var (decompiled, repair) = (repairedSource.Decompiled, repairedSource.Written);
        if (decompiled.Source is not { } repaired)
        {
            return Refused(decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                ? DecompileAndRepairRefusal.MissingLocalizationStrings
                : DecompileAndRepairRefusal.RoundTripFailed, decompiled.Message);
        }
        if (!_adapter.BaselineOf(plugin, repair, repaired.Files, loadOrder).Holds(out var baseline, out failure))
            return RefusedAs(plugin, failure);

        var repairedCommit = new TreeCommit(repaired.Files, RepairMessage(plugin, repair));
        if (!inSourceMod)
        {
            if (item.SourceFolder is not { } made)
                return Refused(DecompileAndRepairRefusal.NoSourceFolder, $"{mod.Name} is not a source mod, and the request hands no source folder to make.");
            var leftOut = repairedHere.Where(key => !PluginAddress.Comparer.Equals(key, plugin.Key)).ToHashSet(PluginAddress.Comparer);
            var init = await _init.InitAsync(
                loadOrder, new ModToVersionInGit(mod.Name, mod.Folder, made, Commit: true),
                leftOut, new RepairedInInit(plugin, baseline, repair.OriginalSha256, repairedCommit), _ => { }, cancel);
            if (init is ItemAnswer<VersionInGitRefusal, IReadOnlyList<PluginAddress>>.Refusing(var initRefusal, var initMessage))
                return Refused(RefusalOfInit(initRefusal), $"{mod.Name} is not a source mod, and making a source folder for {plugin.Name} was refused: {initMessage}");
            newSourceFolder.LeftOut.UnionWith(leftOut);
            newSourceFolder.Held.UnionWith(((ItemAnswer<VersionInGitRefusal, IReadOnlyList<PluginAddress>>.Wrote)init).Outcome);
            return ItemAnswer<DecompileAndRepairRefusal, NoOutcome>.Landed(default);
        }

        switch (repository.CommitRepair(plugin.Key, new TreeCommit(baseline, BaselineMessage(plugin, repair)), repairedCommit, repair.OriginalSha256))
        {
            case null:
                return ItemAnswer<DecompileAndRepairRefusal, NoOutcome>.Landed(default);
            case SourceFailure.GitUnavailable gitMissing:
                return Refused(DecompileAndRepairRefusal.GitUnavailable, gitMissing.Reason);
            case SourceFailure.TwinFolders twins:
                return Refused(DecompileAndRepairRefusal.AmbiguousSource, twins.Reason);
            case var written:
                _logger.LogWarning("Refused to decompile and repair {Plugin}: {Reason}", plugin.Name, written.Reason);
                return Refused(DecompileAndRepairRefusal.WriteFailed, $"Could not write {plugin.Name}'s source: {written.Reason}");
        }
    }

    private static ItemAnswer<DecompileAndRepairRefusal, NoOutcome> RefusedAs(RegisteredPlugin plugin, PluginFailure failure) => failure switch
    {
        PluginFailure.NoRepair => Refused(DecompileAndRepairRefusal.NoRepair, $"{plugin.Name} cannot be repaired: {failure.Reason}."),
        PluginFailure.Inaccessible => Refused(DecompileAndRepairRefusal.Unreadable, $"{plugin.Name} could not be read: {failure.Reason}"),
        PluginFailure.RepairUnverified => Refused(DecompileAndRepairRefusal.RoundTripFailed, $"{plugin.Name}'s repair was refused: {failure.Reason}."),
        _ => Refused(DecompileAndRepairRefusal.RepairFailed, $"{plugin.Name}'s repair could not be made: {failure.Reason}."),
    };

    private static DecompileAndRepairRefusal RefusalOfInit(VersionInGitRefusal refusal) => refusal switch
    {
        VersionInGitRefusal.AlreadyInitialized or VersionInGitRefusal.AnotherRepository => DecompileAndRepairRefusal.AnotherRepository,
        VersionInGitRefusal.CommitFailed => DecompileAndRepairRefusal.WriteFailed,
        VersionInGitRefusal.MalformedRepairable => DecompileAndRepairRefusal.OtherPluginRepairable,
        _ => DecompileAndRepairRefusal.OtherPluginRefused,
    };

    private static string BaselineMessage(RegisteredPlugin plugin, RepairedPlugin written) =>
        $"Decompile {plugin.Name} as it was, each malformed record a placeholder\n\n"
        + string.Join('\n', written.Repairs.Select(repair => repair.Diagnosis.Describe()));

    private static string RepairMessage(RegisteredPlugin plugin, RepairedPlugin written) =>
        $"Repair {plugin.Name}\n\n" + string.Join('\n', written.Repairs.Select(repair => $"{repair.Diagnosis.Describe()}\n  {repair.Change.Description}"));

    private sealed class SamePlugin : IEqualityComparer<PluginToRepair>
    {
        internal static readonly SamePlugin Instance = new();

        public bool Equals(PluginToRepair? x, PluginToRepair? y) =>
            x is not null && y is not null && PluginAddress.Comparer.Equals(x.Plugin, y.Plugin);

        public int GetHashCode(PluginToRepair obj) => PluginAddress.Comparer.GetHashCode(obj.Plugin);
    }
}
