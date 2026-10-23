using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>Decompile and repair's preview (plugin-source.md, Decompile and repair): each change before anything is
/// written. Writes nothing.</summary>
public sealed class RepairPreviewsHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly PluginRepairer _repairer;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal RepairPreviewsHandler(LoadOrderHolder loadOrder, IPluginAdapter adapter, ISourceAdapter source, ILogger<RepairPreviewsHandler> logger) =>
        (_loadOrder, _repairer) = (loadOrder, new PluginRepairer(adapter, new PluginDecompiler(logger, adapter, source)));

    public async Task<Answer<RepairPreviewsResult, SelectionRefusal<DecompileAndRepairRefusal>>> PreviewAsync(IReadOnlyList<PluginAddress> plugins)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return new SelectionRefusal<DecompileAndRepairRefusal>(DecompileAndRepairRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var (landed, refused) = await ItemWrite.EachAsync(plugins, PluginAddress.Comparer, key => Task.FromResult(
            RepairTarget.Of(_repairer, loadOrder, key) switch
            {
                RepairTarget.Previewed(var plugin, _, var previews) => ItemAnswer<DecompileAndRepairRefusal, PluginRepairPreview>.Landed(
                    new PluginRepairPreview(plugin.Key, previews.Hash, previews.Diagnoses)),
                RepairTarget.Refused(var refusal, var message) => ItemAnswer<DecompileAndRepairRefusal, PluginRepairPreview>.Refused(refusal, message),
                var target => throw new InvalidOperationException($"Expected a repair target to be previewed or refused, not {target}."),
            }));
        return new RepairPreviewsResult(
            [.. landed.Select(item => item.Outcome)], [.. refused.Select(item => new DecompileAndRepairRefused(item.Item, item.Refusal, item.Message))]);
    }
}

/// <summary>A plugin decompile and repair acts on, previewed, or why it cannot be.</summary>
internal abstract record RepairTarget
{
    internal sealed record Previewed(RegisteredPlugin Plugin, PluginProvider.FromMod Mod, RepairPreviews Previews) : RepairTarget;

    internal sealed record Refused(DecompileAndRepairRefusal Refusal, string Message) : RepairTarget;

    internal static RepairTarget Of(PluginRepairer repairer, LoadOrderSnapshot loadOrder, PluginAddress key)
    {
        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return new Refused(DecompileAndRepairRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to repair.");
        }
        if (plugin.Provider is not PluginProvider.FromMod mod)
        {
            return new Refused(DecompileAndRepairRefusal.NotFromAMod,
                $"{plugin.Name} comes from the game or from no mod, so no mod can hold its source.");
        }
        if (!repairer.Preview(loadOrder, plugin).Holds(out var previews, out var unread))
            return new Refused(DecompileAndRepairRefusal.Unreadable, $"{plugin.Name} could not be read: {unread.Reason}");
        return previews.Diagnoses.Count == 0
            ? new Refused(DecompileAndRepairRefusal.NotMalformed, $"{plugin.Name} is not malformed, so there is nothing to repair. Decompile it instead.")
            : new Previewed(plugin, mod, previews);
    }
}
