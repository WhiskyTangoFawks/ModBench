using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>The record header's flags as the document carries them: one integer member.</summary>
public static class RecordHeaderFlags
{
    public const string Member = nameof(IMajorRecordGetter.MajorRecordFlagsRaw);

    /// <summary>A document omits the member when no bit is set.</summary>
    internal static bool Carry(JsonElement document, int bit) => Document.OfRecord(document).CarriesHeaderFlag(bit);
}
