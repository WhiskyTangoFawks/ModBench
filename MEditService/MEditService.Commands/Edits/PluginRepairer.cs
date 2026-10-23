using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Edits;

/// <summary>A malformed plugin's repairs, previewed, then verified and read into plugin source through
/// decompile's own round-trip gate, so a repair Mutagen still reads with loss never becomes source
/// (ADR-0006). Writes nothing.</summary>
internal sealed class PluginRepairer(IPluginAdapter adapter, PluginDecompiler decompiler)
{
    internal Answer<RepairPreviews, PluginFailure> Preview(LoadOrderSnapshot loadOrder, RegisteredPlugin plugin) =>
        adapter.RepairsOf(plugin.Path, loadOrder.GameRelease);

    /// <summary>The repaired plugin's source, or the decompile gate's refusal of it; the port's failure when
    /// the repair itself is refused.</summary>
    internal async Task<Answer<Decompiled, PluginFailure>> DecompileRepairedAsync(
        LoadOrderSnapshot loadOrder, RegisteredPlugin plugin, string previewedHash, IReadOnlyCollection<PluginDiagnosis> chosen, string modFolder,
        CancellationToken cancel)
    {
        using var scratch = ScratchPlugin.For(plugin.Name);
        var release = loadOrder.GameRelease;
        if (!adapter.WriteRepaired(plugin.Path, previewedHash, chosen, scratch.PluginPath, release).Holds(out var repaired, out var refused)
            || !adapter.VerifyRepaired(plugin.Path, previewedHash, chosen, repaired, release).Holds(out _, out refused))
            return refused;
        return await decompiler.DecompileAsync(loadOrder, plugin with { Path = repaired }, modFolder, onParsed: () => { }, cancel, namesRepair: false);
    }
}
