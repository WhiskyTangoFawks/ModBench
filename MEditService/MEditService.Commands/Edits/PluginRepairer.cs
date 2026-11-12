using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Edits;

/// <summary>A malformed plugin's repairs, diagnosed, then verified and read into plugin source through
/// decompile's own round-trip gate, so a repair Mutagen still reads with loss never becomes source
/// (ADR-0006). Writes nothing.</summary>
internal sealed class PluginRepairer(IPluginAdapter adapter, PluginDecompiler decompiler)
{
    internal Answer<IReadOnlyList<RepairPreview>, PluginFailure> Diagnose(LoadOrderSnapshot loadOrder, RegisteredPlugin plugin) =>
        adapter.RepairsOf(plugin.Path, loadOrder.GameRelease);

    /// <summary>The repaired plugin's source with the repair it came from, or the decompile gate's refusal of it; the
    /// port's failure when the repair itself is refused.</summary>
    internal async Task<Answer<RepairedSource, PluginFailure>> DecompileRepairedAsync(
        LoadOrderSnapshot loadOrder, RegisteredPlugin plugin, string modFolder,
        CancellationToken cancel)
    {
        using var scratch = ScratchPlugin.For(plugin.Name);
        var release = loadOrder.GameRelease;
        if (!adapter.WriteRepaired(plugin.Path, scratch.PluginPath, release).Holds(out var written, out var refused)
            || !adapter.VerifyRepaired(written, release).Holds(out _, out refused))
            return refused;
        return new RepairedSource(
            await decompiler.DecompileAsync(loadOrder, plugin with { Path = written.Path }, modFolder, onParsed: () => { }, cancel), written);
    }
}

internal sealed record RepairedSource(Decompiled Decompiled, RepairedPlugin Written);
