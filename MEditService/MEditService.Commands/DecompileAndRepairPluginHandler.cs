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

/// <summary>The decompile and repair gesture's handler (plugin-source.md, Decompile and repair): a malformed plugin into
/// its mod's plugin source as two commits, the malformed records flagged, then repaired. A repair that drops data is
/// refused.</summary>
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
        ILogger<DecompileAndRepairPluginHandler> logger)
    {
        var decompiler = new PluginDecompiler(logger, adapter, source);
        (_loadOrder, _adapter, _source, _logger) = (loadOrder, adapter, source, logger);
        _repairer = new PluginRepairer(adapter, decompiler);
        _init = new ModInit(logger, adapter, source, modFolders, decompiler);
    }

    /// <summary>A mod with no repository gets one, made as decompile and commit makes it, leaving out
    /// <paramref name="metadataFiles"/>. A plugin whose source has working-tree changes is refused unless
    /// <paramref name="force"/>.</summary>
    public async Task<Answer<DecompileAndRepairResult, SelectionRefusal<DecompileAndRepairRefusal>>> DecompileAndRepairAsync(
        IReadOnlyList<PluginToRepair> plugins, IReadOnlyList<string> metadataFiles, bool force, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return new SelectionRefusal<DecompileAndRepairRefusal>(DecompileAndRepairRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var selected = plugins.Select(item => item.Plugin).ToHashSet(PluginAddress.Comparer);
        var repaired = await ItemWrite.OverAsync(_source, plugins, SamePlugin.Instance, DecompileAndRepairRefusal.GitUnavailable, item =>
        {
            cancel.ThrowIfCancellationRequested();
            return RepairOneAsync(loadOrder, item, selected, metadataFiles, force, cancel);
        });
        return repaired.ToAnswer(
            landed => landed.Item.Plugin,
            refused => new DecompileAndRepairRefused(refused.Item.Plugin, refused.Refusal, refused.Message),
            (applied, refused) => new DecompileAndRepairResult(applied, refused));
    }

    private static ItemAnswer<DecompileAndRepairRefusal, NoOutcome> Refused(DecompileAndRepairRefusal refusal, string message) =>
        ItemAnswer<DecompileAndRepairRefusal, NoOutcome>.Refused(refusal, message);

    private async Task<ItemAnswer<DecompileAndRepairRefusal, NoOutcome>> RepairOneAsync(
        LoadOrderSnapshot loadOrder, PluginToRepair item, IReadOnlySet<PluginAddress> selected, IReadOnlyList<string> metadataFiles, bool force,
        CancellationToken cancel)
    {
        var target = RepairTarget.Of(_repairer, loadOrder, item.Plugin);
        if (target is RepairTarget.Refused(var targetRefusal, var targetMessage)) return Refused(targetRefusal, targetMessage);
        var (plugin, mod, previews) = (RepairTarget.Previewed)target;
        if (previews.Diagnoses.Where(preview => preview.Change is { DroppedBytes: > 0 }).ToList() is [_, ..] dropping)
        {
            return Refused(DecompileAndRepairRefusal.DropsData,
                $"Repairing {plugin.Name} drops data, so nothing was written: " + string.Join("; ", dropping.Select(Named)) + ".");
        }

        var sourceFolder = mod.SourceFolder ?? item.SourceFolder;
        if (sourceFolder is null)
            return Refused(DecompileAndRepairRefusal.NoSourceFolder, $"{mod.Name} has no repository, and the request names no source folder to make one in.");
        var inSourceMod = _source.IsSourceMod(sourceFolder);
        var repository = _source.OverFolder(mod with { SourceFolder = sourceFolder }, loadOrder.GameRelease);
        if (inSourceMod && !force && WorkingTreeCheck.Of(repository, plugin.Key, "decompile and repair") is { } loss)
            return Refused(loss.Unreadable ? DecompileAndRepairRefusal.WorkingTreeStatusUnreadable : DecompileAndRepairRefusal.WorkingTreeChanges, loss.Message);

        var chosen = previews.Diagnoses.Select(preview => preview.Diagnosis).ToList();
        if (!(await _repairer.DecompileRepairedAsync(loadOrder, plugin, item.Hash, chosen, mod.Folder, cancel)).Holds(out var decompiled, out var failure))
            return RefusedAs(plugin, failure);
        if (decompiled.Source is not { } repaired)
        {
            return Refused(decompiled.Refusal == DecompileRefusal.MissingLocalizationStrings
                ? DecompileAndRepairRefusal.MissingLocalizationStrings
                : DecompileAndRepairRefusal.RoundTripFailed, decompiled.Message);
        }
        if (!_adapter.FlaggedSourceOf(plugin, item.Hash, chosen, repaired, loadOrder).Holds(out var flagged, out failure))
            return RefusedAs(plugin, failure);

        var repairedCommit = new TreeCommit(repaired.Files, RepairMessage(plugin, previews));
        if (!inSourceMod)
        {
            var leftOut = selected.Where(key => !PluginAddress.Comparer.Equals(key, plugin.Key)).ToHashSet(PluginAddress.Comparer);
            var init = await _init.InitAsync(
                loadOrder, new ModToDecompileAndCommit(mod.Name, sourceFolder, metadataFiles), DecompileAndCommitModHandler.ProvidedBy(loadOrder, mod.Name),
                leftOut, new RepairedInInit(plugin, flagged, repairedCommit), _ => { }, cancel);
            return init is ItemAnswer<DecompileAndCommitRefusal, IReadOnlyList<PluginAddress>>.Refusing(var initRefusal, var initMessage)
                ? Refused(RefusalOfInit(initRefusal), $"{mod.Name} has no repository, and making one for {plugin.Name} was refused: {initMessage}")
                : ItemAnswer<DecompileAndRepairRefusal, NoOutcome>.Landed(default);
        }

        var flaggedCommit = new TreeCommit(flagged.Files, FlaggedMessage(plugin, previews));
        switch (repository.CommitRepair(plugin.Key, flaggedCommit, repairedCommit, flagged.BinarySha256))
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

    private static ItemAnswer<DecompileAndRepairRefusal, NoOutcome> ChangedSincePreview(RegisteredPlugin plugin) =>
        Refused(DecompileAndRepairRefusal.ChangedSincePreview,
            $"{plugin.Name}'s bytes changed since the repair preview, so nothing was written. Run decompile and repair again to preview them.");

    private static ItemAnswer<DecompileAndRepairRefusal, NoOutcome> RefusedAs(RegisteredPlugin plugin, PluginFailure failure) => failure switch
    {
        PluginFailure.ChangedSincePreview => ChangedSincePreview(plugin),
        PluginFailure.NoRepair => Refused(DecompileAndRepairRefusal.NoRepair, $"{plugin.Name} cannot be repaired: {failure.Reason}."),
        PluginFailure.Inaccessible => Refused(DecompileAndRepairRefusal.Unreadable, $"{plugin.Name} could not be read: {failure.Reason}"),
        _ => Refused(DecompileAndRepairRefusal.RoundTripFailed, $"{plugin.Name}'s repair was refused: {failure.Reason}."),
    };

    private static DecompileAndRepairRefusal RefusalOfInit(DecompileAndCommitRefusal refusal) => refusal switch
    {
        DecompileAndCommitRefusal.AlreadyInitialized => DecompileAndRepairRefusal.AnotherRepository,
        DecompileAndCommitRefusal.ModFilesUnreadable => DecompileAndRepairRefusal.ModFilesUnreadable,
        DecompileAndCommitRefusal.CommitFailed => DecompileAndRepairRefusal.WriteFailed,
        _ => DecompileAndRepairRefusal.OtherPluginRefused,
    };

    private static string Named(RepairPreview preview) => $"{preview.Diagnosis.Anchor ?? "the plugin"}: {preview.Change?.Description}";

    private static string FlaggedMessage(RegisteredPlugin plugin, RepairPreviews previews) =>
        $"Decompile {plugin.Name}, its malformed records flagged\n\n" + string.Join('\n', previews.Diagnoses.Select(preview => preview.Diagnosis.Describe()));

    private static string RepairMessage(RegisteredPlugin plugin, RepairPreviews previews) =>
        $"Repair {plugin.Name}\n\n" + string.Join('\n', previews.Diagnoses.Select(Named));

    private sealed class SamePlugin : IEqualityComparer<PluginToRepair>
    {
        internal static readonly SamePlugin Instance = new();

        public bool Equals(PluginToRepair? x, PluginToRepair? y) =>
            x is not null && y is not null && PluginAddress.Comparer.Equals(x.Plugin, y.Plugin);

        public int GetHashCode(PluginToRepair obj) => PluginAddress.Comparer.GetHashCode(obj.Plugin);
    }
}
