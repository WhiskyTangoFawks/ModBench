using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
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
    public Task<SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>> DecompileAsync(
        IReadOnlyList<PluginAddress> plugins, bool force, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
        {
            return Task.FromResult(SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>.WholeSelectionRefused(
                DecompileRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage));
        }

        return ItemWrite.OverAsync(_source, plugins, PluginAddress.Comparer, DecompileRefusal.GitUnavailable, plugin =>
        {
            cancel.ThrowIfCancellationRequested();
            return DecompileOneAsync(loadOrder, plugin, force, cancel);
        });
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
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.NotInSourceMod,
                $"{plugin.Name} is not in a mod, so there is no source mod to decompile it into.");
        }

        if (!_source.IsTracked(plugin))
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.NotInSourceMod,
                $"{plugin.Name} is not in a source mod, so there is no working tree to decompile it into. "
                + "Run git init on the modlist if the instance is not a repository, then decompile and commit on the mod.");
        }

        var repository = _source.OverFolder(mod, loadOrder.GameRelease);
        if (!force)
        {
            if (!repository.WorkingTreeChangesOf(key).Holds(out var changes, out var unread))
            {
                return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.WorkingTreeStatusUnreadable, $"Could not read what changed in {plugin.Name}'s source: {unread.Reason}");
            }

            if (changes.Count > 0)
            {
                return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.WorkingTreeChanges,
                    $"{plugin.Name}'s source has working-tree changes that decompile would replace: {string.Join(", ", changes)}. Request it again with force to replace them.");
            }
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
