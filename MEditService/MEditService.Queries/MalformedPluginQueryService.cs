using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;

namespace MEditService.Queries;

/// <summary>Kind B diagnoses as rows, in the load order that holds them. Immutable copies are never
/// reported: they are the proof set the tables were built from (docs/specs/medit-repair.md).
/// </summary>
public sealed class MalformedPluginQueryService(IQueryIndex index, LoadOrderHolder loadOrder)
{
    public IReadOnlyList<PluginDiagnosisReport> GetLoadOrderDiagnoses()
    {
        var byCopy = index.RequireReads().GetPluginDiagnoses().ToLookup(row => row.Plugin, PluginCopyKey.Comparer);
        return
        [
            .. loadOrder.Require().Copies
                .Where(copy => !copy.IsImmutable)
                .SelectMany(copy => byCopy[copy.Key].Select(row => Report(copy, row.Diagnosis))),
        ];
    }

    private static PluginDiagnosisReport Report(RegisteredCopy copy, PluginDiagnosis diagnosis) =>
        new(copy.Name, copy.Origin, diagnosis.Anchor, diagnosis.DefectClass, diagnosis.Tail,
            diagnosis.Message, diagnosis.Describe());
}
