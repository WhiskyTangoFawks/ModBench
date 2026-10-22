using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class WrongFixedCountList : IMalformation
{
    // Every list the shapes count is of names, and vanilla writes an unnamed one as its terminator alone.
    private const int EmptyNameLength = 1;

    public bool Reads(string recordType, CreationKitShapes shapes) =>
        shapes.SubrecordCounts.Keys.Any(k => k.RecordType == recordType);

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        foreach (var ((type, sig), expected) in record.Shapes.SubrecordCounts)
        {
            if (type != record.Type) continue;
            var last = -1;
            var count = 0;
            for (var i = 0; i < record.Subrecords.Count; i++)
            {
                if (record.Subrecords[i].Signature != sig) continue;
                last = i;
                count++;
            }
            if (count == 0 || count == expected) continue;

            // Which of too many entries another tool added, no byte says.
            IReadOnlyList<SubrecordEdit>? repair = count < expected ? [new InsertDefault(last + 1, sig, EmptyNameLength, expected - count)] : null;
            yield return new Malformed("fixed-count-list-wrong-count",
                $"{sig} appears {count} times; the Creation Kit always writes {expected}", repair);
        }
    }
}
