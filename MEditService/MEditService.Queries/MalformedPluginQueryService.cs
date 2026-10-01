using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Queries;

/// <summary>Kind B diagnoses as rows, the active plugins in load order first. The plugins loaded with
/// no line, the game's own, are never reported: they are the proof set the tables were built from.</summary>
public sealed class MalformedPluginQueryService(IQueryIndex index, LoadOrderHolder loadOrder)
{
    public IReadOnlyList<PluginDiagnosisReport> GetLoadOrderDiagnoses()
    {
        var reads = index.RequireReads();
        var held = loadOrder.Require();
        // Derived from the whole plugin set, so a partial projection answers nothing: a plugin it has
        // not reached holds no rows yet and would read clean.
        if (index.Status.State != LoadOrderState.Ready) return [];

        var byPlugin = reads.GetPluginDiagnoses().ToLookup(row => row.Plugin, PluginAddress.Comparer);
        return
        [
            .. held.Plugins
                .Where(plugin => !held.LoadedWithNoLine.Contains(plugin))
                .OrderBy(plugin => held.LoadOrderIndex(plugin.Key) ?? int.MaxValue)
                .SelectMany(plugin => byPlugin[plugin.Key].Select(row => Report(plugin, row.Diagnosis))),
        ];
    }

    private static PluginDiagnosisReport Report(RegisteredPlugin plugin, PluginDiagnosis diagnosis) =>
        new(plugin.Name, plugin.Origin, diagnosis.Anchor, diagnosis.DefectClass, diagnosis.Tail,
            diagnosis.Message, diagnosis.Describe());
}
