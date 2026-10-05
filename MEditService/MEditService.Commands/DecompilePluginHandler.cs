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

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal DecompilePluginHandler(LoadOrderHolder loadOrder, IPluginAdapter adapter, ILogger<DecompilePluginHandler> logger) =>
        (_loadOrder, _decompiler) = (loadOrder, new PluginDecompiler(logger, adapter));

    /// <summary>Throws <see cref="NoLoadOrderException"/> with nothing written when none is held; git
    /// missing refuses the whole selection once, before any write (commands.md, A selection is one
    /// gesture).</summary>
    public Task<SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>> DecompileAsync(
        IReadOnlyList<PluginAddress> plugins, CancellationToken cancel = default)
    {
        var loadOrder = _loadOrder.Require();
        return ItemWrite.OverAsync(plugins, PluginAddress.Comparer, DecompileRefusal.GitUnavailable, plugin =>
        {
            cancel.ThrowIfCancellationRequested();
            return DecompileOneAsync(loadOrder, plugin, cancel);
        });
    }

    private async Task<ItemAnswer<DecompileRefusal, NoOutcome>> DecompileOneAsync(
        LoadOrderSnapshot loadOrder, PluginAddress key, CancellationToken cancel)
    {
        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to decompile.");
        }

        if (plugin.Provider is not PluginProvider.FromMod mod
            || SourceRepository.Open(mod, loadOrder.GameRelease) is not { } repository)
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.NotInTrackedMod,
                $"{plugin.Name} is not in a tracked mod, so there is no working tree to decompile it into.");
        }

        var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, mod.Folder, onParsed: () => { }, cancel);
        if (decompiled.Files is not { } files) return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(decompiled.Refusal, decompiled.Message);

        try
        {
            repository.ReplaceSourceFrom(key, files, PluginBinaryHash.TrailerFormOfFile(plugin.Path));
            return ItemAnswer<DecompileRefusal, NoOutcome>.Landed(default);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return ItemAnswer<DecompileRefusal, NoOutcome>.Refused(DecompileRefusal.WriteFailed, $"Could not write {plugin.Name}'s source: {ex.Message}");
        }
    }
}
