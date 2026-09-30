using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Queries;

/// <summary>Kind B diagnoses as rows, in load order. Immutable plugins are never reported: the game
/// folder's are the proof set the tables were built from, and the game loads no inactive one.</summary>
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
            .. held.Active
                .Where(plugin => !held.IsImmutable(plugin.Key))
                .SelectMany(plugin => byPlugin[plugin.Key].Select(row => Report(plugin, row.Diagnosis))),
        ];
    }

    private static PluginDiagnosisReport Report(RegisteredPlugin plugin, PluginDiagnosis diagnosis) =>
        new(plugin.Name, plugin.Origin, diagnosis.Anchor, diagnosis.DefectClass, diagnosis.Tail,
            diagnosis.Message, diagnosis.Describe());
}
