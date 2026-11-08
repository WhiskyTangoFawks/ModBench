using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class FurnMissingFnamAndMnam : IMalformation
{
    // Vanilla Fallout 4 and Skyrim write FNAM before the first of these, and MNAM directly before WBDT.
    private static readonly string[] FollowingFnam = ["KNAM", "CITC", "COCT", "WBDT"];
    private static readonly string[] FollowingMnam = ["WBDT"];

    public bool Reads(string recordType, CreationKitShapes shapes) => recordType == "FURN";

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        var subrecords = record.Subrecords;
        if (subrecords.Any(s => s.Signature is "FNAM" or "MNAM")) yield break;
        // Mutagen writes an absent Flags as FNAM 0 and MNAM 0.
        yield return new Malformed("furn-missing-fnam-and-mnam", "FNAM and MNAM are missing; vanilla always writes both",
            [new InsertDefault(FirstOf(subrecords, FollowingFnam), "FNAM", 2, 1), new InsertDefault(FirstOf(subrecords, FollowingMnam), "MNAM", 4, 1)]);
    }

    private static int FirstOf(IReadOnlyList<Subrecord> subrecords, string[] signatures)
    {
        for (var i = 0; i < subrecords.Count; i++)
        {
            if (signatures.Contains(subrecords[i].Signature)) return i;
        }
        return subrecords.Count;
    }
}
