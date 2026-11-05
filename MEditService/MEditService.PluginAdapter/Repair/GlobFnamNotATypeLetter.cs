using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class GlobFnamNotATypeLetter : IMalformation
{
    private const string TypeLetters = "slfb";

    public bool Reads(string recordType, CreationKitShapes shapes) => recordType == "GLOB";

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        for (var i = 0; i < record.Subrecords.Count; i++)
        {
            var sub = record.Subrecords[i];
            if (sub.Signature != "FNAM" || (sub.Payload.Length == 1 && TypeLetters.Contains((char)sub.Payload.Span[0]))) continue;
            var written = sub.Payload.Length == 1 ? $"0x{sub.Payload.Span[0]:X2}" : $"{sub.Payload.Length} bytes";
            yield return new Malformed("glob-fnam-not-a-type-letter",
                $"FNAM is {written}; vanilla writes s, l, f or no FNAM", [new Drop([i])]);
        }
    }
}
