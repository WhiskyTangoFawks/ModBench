using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Index.Queries;

/// <summary>Kind B diagnoses as rows, the active plugins in load order first. The plugins loaded with
/// no line, the game's own, are never reported: they are the proof set the tables were built from.</summary>
internal static class LoadOrderDiagnoses
{
    public static IReadOnlyList<PluginDiagnosisReport> Of(IRecordReads reads, LoadOrderSnapshot held)
    {
        var byPlugin = reads.GetPluginDiagnoses().ToLookup(row => row.Plugin, PluginAddress.Comparer);
        var loadedWithNoLine = held.LoadedWithNoLine.Select(plugin => plugin.Key).ToHashSet(PluginAddress.Comparer);
        return
        [
            .. held.Plugins
                .Where(plugin => !loadedWithNoLine.Contains(plugin.Key))
                .OrderBy(plugin => held.LoadOrderIndex(plugin.Key) ?? int.MaxValue)
                .SelectMany(plugin => byPlugin[plugin.Key].Select(row => Report(plugin, row.Diagnosis))),
        ];
    }

    private static PluginDiagnosisReport Report(RegisteredPlugin plugin, PluginDiagnosis diagnosis) =>
        new(plugin.Name, plugin.Origin, diagnosis.Anchor, diagnosis.DefectClass, diagnosis.Tail,
            diagnosis.Message, diagnosis.Describe());
}
