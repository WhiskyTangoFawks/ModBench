using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.TestSupport;

public static class ReadBack
{
    /// <summary>The record as the codec's round trip spells it, read into a graph of its own class.</summary>
    public static T Of<T>(RecordTextCodec codec, IMajorRecordGetter record, GameRelease release, string? recordType)
        where T : class, IMajorRecordGetter =>
        (T)RecordTextCodec.DeserializeText(
            typeof(T), codec.RoundTrip(codec.SerializeToText(record, release), release, recordType), release);
}
