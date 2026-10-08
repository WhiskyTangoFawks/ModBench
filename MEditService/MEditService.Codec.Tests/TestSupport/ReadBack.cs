using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Codec.Tests.TestSupport;

public static class ReadBack
{
    /// <summary>The record as the codec's round trip spells it.</summary>
    public static JsonElement Of(RecordTextCodec codec, IMajorRecordGetter record, GameRelease release, string? recordType)
    {
        using var document = JsonDocument.Parse(codec.RoundTrip(codec.SerializeToText(record, release), release, recordType));
        return document.RootElement.Clone();
    }

    /// <summary>The record <paramref name="mod"/> holds at <paramref name="record"/>'s FormKey, read
    /// back into a graph of its own class through the whole-mod door compile reads with.</summary>
    public static async Task<T> ThroughTheWholeModDoor<T>(IFallout4ModGetter mod, T record)
        where T : IMajorRecordGetter
    {
        using var folder = new ScratchDirectory("medit-readback-");
        await RecordTextCodecGeneratorSeed.SerializeWholeMod(mod, folder.Path, InlineWorkDropoff.Instance, CancellationToken.None);
        var read = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder.Path, InlineWorkDropoff.Instance, CancellationToken.None);
        return read.EnumerateMajorRecords().OfType<T>().Single(candidate => candidate.FormKey == record.FormKey);
    }
}
