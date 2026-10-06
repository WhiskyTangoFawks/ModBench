using System.Text.Json;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>The record header's flags as the document carries them: one integer member.</summary>
public static class RecordHeaderFlags
{
    public const string Member = nameof(IMajorRecordGetter.MajorRecordFlagsRaw);

    /// <summary>A document omits the member when no bit is set.</summary>
    public static bool Carry(JsonElement document, int bit) =>
        document.TryGetProperty(Member, out var flags)
        && flags.ValueKind == JsonValueKind.Number
        && (flags.GetInt32() & bit) != 0;
}
