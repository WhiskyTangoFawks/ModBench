using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The decompile gesture's handler (ADR-0007).</summary>
public sealed class DecompilePluginHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal DecompilePluginHandler(LoadOrderHolder loadOrder, IPluginAdapter adapter, ISourceAdapter source, ILogger<DecompilePluginHandler> logger) =>
        (_loadOrder, _source, _decompiler) = (loadOrder, source, new PluginDecompiler(logger, adapter, source));

    /// <summary>Refuses with <see cref="DecompileRefusal.NoLoadOrder"/>, writing nothing, when none is held; git
    /// missing refuses the whole selection once. A plugin whose source has working-tree changes is refused
    /// unless <paramref name="force"/>.</summary>
    public async Task<Answer<DecompileResult, SelectionRefusal<DecompileRefusal>>> DecompileAsync(
        IReadOnlyList<PluginAddress> plugins, bool force, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return new SelectionRefusal<DecompileRefusal>(DecompileRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var decompiled = await ItemWrite.OverAsync(_source, plugins, PluginAddress.Comparer, DecompileRefusal.GitUnavailable, plugin =>
        {
            cancel.ThrowIfCancellationRequested();
            return DecompileOneAsync(loadOrder, plugin, force, cancel);
        });
        return decompiled.ToAnswer(
            landed => landed.Item,
            refused => new DecompileRefused(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new DecompileResult(applied, refused));
    }

    private async Task<ItemAnswer<DecompileRefusal, NoOutcome>> DecompileOneAsync(
        LoadOrderSnapshot loadOrder, PluginAddress key, bool force, CancellationToken cancel)
    {
        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to decompile.");
        }

        if (plugin.Provider is not PluginProvider.FromMod mod)
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.NotFromAMod,
                $"{plugin.Name} comes from the game or from no mod, so no mod can hold its source.");
        }

        if (!_source.IsSourceMod(plugin))
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.NotInSourceMod,
                $"{plugin.Name} is not in a source mod, so there is no working tree to decompile it into. "
                + $"Run decompile and commit on {mod.Name}.");
        }

        var repository = _source.OverFolder(mod, loadOrder.GameRelease);
        if (!force && WorkingTreeCheck.Of(repository, plugin.Key, "decompile") is { } loss)
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(
                loss.Unreadable ? DecompileRefusal.WorkingTreeStatusUnreadable : DecompileRefusal.WorkingTreeChanges, loss.Message);
        }

        var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, mod.Folder, onParsed: () => { }, cancel);
        if (decompiled.Source is not { } source) return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(decompiled.Refusal, decompiled.Message);

        return repository.ReplaceSourceFrom(key, source.Files, source.BinarySha256) switch
        {
            null => ItemAnswer<DecompileRefusal, NoOutcome>.Landed(default),
            SourceFailure.GitUnavailable gitMissing => ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.GitUnavailable, gitMissing.Reason),
            SourceFailure.TwinFolders twins => ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.AmbiguousSource, twins.Reason),
            var failure => ItemAnswer<DecompileRefusal, NoOutcome>.Refused(
                DecompileRefusal.WriteFailed, $"Could not write {plugin.Name}'s source: {failure.Reason}"),
        };
    }
}
