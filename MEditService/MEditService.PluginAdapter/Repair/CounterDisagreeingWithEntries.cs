using System.Buffers.Binary;
using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class CounterDisagreeingWithEntries : IMalformation
{
    public bool Reads(string recordType, CreationKitShapes shapes) =>
        shapes.CountedEntries.Keys.Any(k => k.RecordType == recordType);

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        var subrecords = record.Subrecords;
        for (var i = 0; i < subrecords.Count; i++)
        {
            var counter = subrecords[i];
            if (!record.Shapes.CountedEntries.TryGetValue((record.Type, counter.Signature), out var entrySig)) continue;
            if (counter.Payload.Length < sizeof(uint)) continue; // a short counter is the fixed-size class's finding, not a count disagreement
            var declared = BinaryPrimitives.ReadUInt32LittleEndian(counter.Payload);
            var actual = 0;
            for (var j = i + 1; j < subrecords.Count && subrecords[j].Signature == entrySig; j++) actual++;
            if (actual != declared)
            {
                yield return new Malformed("counter-entries-mismatch",
                    $"{counter.Signature} counts {declared}; {actual} {entrySig} entries follow",
                    [new Recount(i, (uint)actual)]);
            }
        }
    }
}
