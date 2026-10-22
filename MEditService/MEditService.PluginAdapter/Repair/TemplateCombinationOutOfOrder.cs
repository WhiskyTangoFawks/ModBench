using System.Buffers.Binary;
using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

/// <summary>Combinations are written OBTF, FULL, OBTS after an optional bare leading OBTS; a trailing
/// OBTF/FULL with no closing OBTS is the defect.</summary>
internal sealed class TemplateCombinationOutOfOrder : IMalformation
{
    public bool Reads(string recordType, CreationKitShapes shapes) => shapes.TemplateCombinations.Contains(recordType);

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        var signatures = record.Subrecords.Select(s => s.Signature).ToList();
        var start = signatures.IndexOf("OBTE");
        if (start < 0) yield break;
        var end = signatures.IndexOf("STOP", start);
        if (end < 0) end = signatures.Count;
        var template = signatures[(start + 1)..end];

        var lastObts = template.LastIndexOf("OBTS");
        var lastDress = Math.Max(template.LastIndexOf("OBTF"), template.LastIndexOf("FULL"));
        if (lastDress < 0 || lastDress < lastObts) yield break;

        yield return new Malformed("subrecord-out-of-ck-order",
            $"template combination {CountClosedGroups(template)}'s OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS",
            IsOneRotatedCombination(record.Subrecords[start], template) ? [new Reorder(start + 1, end)] : null);
    }

    // With more than one combination, a dangling OBTF/FULL could be any one's; with OBTE counting two,
    // the leading OBTS could be the bare one.
    private static bool IsOneRotatedCombination(Subrecord counter, List<string> template) =>
        counter.Payload.Length >= sizeof(uint) && BinaryPrimitives.ReadUInt32LittleEndian(counter.Payload) == 1
        && template.Count(sig => sig == "OBTS") == 1 && template[0] == "OBTS";

    // The record index the dangling combination would have taken.
    private static int CountClosedGroups(List<string> template)
    {
        var closed = 0;
        var open = false;
        foreach (var sig in template)
        {
            if (sig is "OBTF" or "FULL") open = true;
            else if (sig == "OBTS" && open) { closed++; open = false; }
        }
        return closed;
    }
}
