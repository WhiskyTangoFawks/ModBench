using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.TestSupport;

public static class ReadBack
{
    /// <summary>The record as the codec's round trip spells it.</summary>
    public static JsonElement Of(RecordTextCodec codec, IMajorRecordGetter record, GameRelease release, string? recordType)
    {
        using var document = JsonDocument.Parse(codec.RoundTrip(codec.SerializeToText(record, release), release, recordType));
        return document.RootElement.Clone();
    }
}
