using System.Text.Json;

namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 5, "Deleted", in every game.</summary>
public static class DeletedFlag
{
    /// <summary>Mutagen's Constants.DeletedFlag, which Mutagen keeps internal.</summary>
    public const int Bit = 0x0000_0020;

    /// <summary>The bit read off a stored document, whose header flags travel as
    /// <c>MajorRecordFlagsRaw</c> (omitted when zero).</summary>
    public static bool IsSet(JsonElement document) =>
        document.TryGetProperty(RecordHeaderFlags.Member, out var flags)
        && flags.ValueKind == JsonValueKind.Number
        && (flags.GetInt32() & Bit) != 0;
}
