using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class FurnMissingFnamAndMnam : IMalformation
{
    public bool Reads(string recordType, CreationKitShapes shapes) => recordType == "FURN" && shapes.FurnitureFlags is not null;

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        var subrecords = record.Subrecords;
        if (record.Shapes.FurnitureFlags is not { } shapes || subrecords.Any(s => s.Signature is "FNAM" or "MNAM")) yield break;
        // Mutagen writes an absent Flags as FNAM 0 and MNAM 0.
        yield return new Malformed("furn-missing-fnam-and-mnam", "FNAM and MNAM are missing; vanilla always writes both",
        [
            new InsertDefault(FirstOf(subrecords, shapes.FollowingFnam), "FNAM", 2, 1),
            new InsertDefault(FirstOf(subrecords, shapes.FollowingMnam), "MNAM", 4, 1),
        ]);
    }

    private static int FirstOf(IReadOnlyList<Subrecord> subrecords, IReadOnlyList<string> signatures)
    {
        for (var i = 0; i < subrecords.Count; i++)
        {
            if (signatures.Contains(subrecords[i].Signature)) return i;
        }
        return subrecords.Count;
    }
}
