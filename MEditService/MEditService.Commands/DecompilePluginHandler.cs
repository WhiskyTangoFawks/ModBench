using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The decompile gesture's handler (ADR-0007 invariant 2): each plugin's bytes read into its
/// plugin source, in the working tree of its tracked mod. It commits nothing.</summary>
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
    public async Task<DecompileSelectionResult> DecompileAsync(IReadOnlyList<PluginAddress> plugins, CancellationToken cancel = default)
    {
        var loadOrder = _loadOrder.Require();
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return DecompileSelectionResult.WholeSelectionRefused(DecompileRefusal.GitUnavailable, ex.Message);
        }

        var landed = new List<PluginAddress>();
        var refused = new List<DecompileRefused>();
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
                landed.Add(plugin);
            }
        }
        return DecompileSelectionResult.PerPlugin(landed, refused);
    }

    private async Task<DecompileRefused?> DecompileOneAsync(LoadOrderSnapshot loadOrder, PluginAddress key, CancellationToken cancel)
    {
        DecompileRefused Refuse(DecompileRefusal refusal, string message) => new(key, refusal, message);

        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return Refuse(DecompileRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to decompile.");
        }

        if (SourceRepository.TrackedModFolderOf(loadOrder, key) is not { } modFolder
            || SourceRepository.Open(modFolder, loadOrder.GameRelease) is not { } repository)
        {
            return Refuse(DecompileRefusal.NotInTrackedMod,
                $"{plugin.Name} is not in a tracked mod, so there is no working tree to decompile it into.");
        }

        var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, modFolder, onParsed: () => { }, cancel);
        if (decompiled.Files is not { } files) return Refuse(decompiled.Refusal, decompiled.Message);

        try
        {
            repository.ReplaceSourceFrom(plugin.Name, files, PluginBinaryHash.TrailerFormOfFile(plugin.Path));
            return null;
        }
        catch (GitUnavailableException ex)
        {
            return Refuse(DecompileRefusal.GitUnavailable, $"Could not write {plugin.Name}'s source: {ex.Message}");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return Refuse(DecompileRefusal.WriteFailed, $"Could not write {plugin.Name}'s source: {ex.Message}");
        }
    }
}
