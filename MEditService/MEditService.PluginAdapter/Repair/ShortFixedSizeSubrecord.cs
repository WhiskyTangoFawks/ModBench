using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class ShortFixedSizeSubrecord : IMalformation
{
    public bool Reads(string recordType, CreationKitShapes shapes) =>
        shapes.SubrecordSizes.Keys.Any(k => k.RecordType == recordType);

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        for (var i = 0; i < record.Subrecords.Count; i++)
        {
            var sub = record.Subrecords[i];
            if (record.Shapes.SubrecordSizes.TryGetValue((record.Type, sub.Signature), out var expected) && sub.Payload.Length < expected)
            {
                yield return new Malformed("fixed-size-subrecord-short",
                    $"{sub.Signature} is {sub.Payload.Length} bytes; a {record.Type} {sub.Signature} is always {expected}",
                    [new Pad(i, expected)]);
            }
        }
    }
}
