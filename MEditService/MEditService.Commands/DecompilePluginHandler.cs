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
    private readonly PluginDecompiler _decompiler;
    private readonly ILogger<DecompilePluginHandler> _logger;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal DecompilePluginHandler(LoadOrderHolder loadOrder, IPluginAdapter adapter, ILogger<DecompilePluginHandler> logger) =>
        (_loadOrder, _decompiler, _logger) = (loadOrder, new PluginDecompiler(logger, adapter), logger);

    /// <summary>Throws <see cref="NoLoadOrderException"/> with nothing written when none is held; git
    /// missing refuses the whole selection once, before any write (commands.md, A selection is one
    /// gesture).</summary>
    public async Task<SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>> DecompileAsync(
        IReadOnlyList<PluginAddress> plugins, CancellationToken cancel = default)
    {
        var loadOrder = _loadOrder.Require();
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>.WholeSelectionRefused(
                DecompileRefusal.GitUnavailable, ex.Message);
        }

        var landed = new List<ItemLanded<PluginAddress, NoOutcome>>();
        var refused = new List<ItemRefused<PluginAddress, DecompileRefusal>>();
        foreach (var plugin in plugins.Distinct(PluginAddress.Comparer))
        {
            cancel.ThrowIfCancellationRequested();
            if (await DecompileOneAsync(loadOrder, plugin, cancel) is { } refusal)
            {
                _logger.LogWarning("Refused to decompile {Plugin} ({Origin}): {Refusal} — {Message}",
                    plugin.Name, plugin.Origin, refusal.Refusal, refusal.Message);
                refused.Add(refusal);
            }
            else
            {
                landed.Add(new(plugin, default));
            }
        }
        return SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>.PerItem(landed, refused);
    }

    private async Task<ItemRefused<PluginAddress, DecompileRefusal>?> DecompileOneAsync(
        LoadOrderSnapshot loadOrder, PluginAddress key, CancellationToken cancel)
    {
        ItemRefused<PluginAddress, DecompileRefusal> Refuse(DecompileRefusal refusal, string message) => new(key, refusal, message);

        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return Refuse(DecompileRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to decompile.");
        }

        if (plugin.Provider is not PluginProvider.FromMod mod
            || SourceRepository.Open(mod, loadOrder.GameRelease) is not { } repository)
        {
            return Refuse(DecompileRefusal.NotInTrackedMod,
                $"{plugin.Name} is not in a tracked mod, so there is no working tree to decompile it into.");
        }

        var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, mod.Folder, onParsed: () => { }, cancel);
        if (decompiled.Files is not { } files) return Refuse(decompiled.Refusal, decompiled.Message);

        try
        {
            repository.ReplaceSourceFrom(key, files, PluginBinaryHash.TrailerFormOfFile(plugin.Path));
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return Refuse(DecompileRefusal.WriteFailed, $"Could not write {plugin.Name}'s source: {ex.Message}");
        }
    }
}
