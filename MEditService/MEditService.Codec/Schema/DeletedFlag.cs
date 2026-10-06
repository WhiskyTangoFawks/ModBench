using System.Text.Json;

namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 5, "Deleted", in every game.</summary>
public static class DeletedFlag
{
    /// <summary>Mutagen's Constants.DeletedFlag, which Mutagen keeps internal.</summary>
    public const int Bit = 0x0000_0020;

    public static bool IsSet(JsonElement document) => RecordHeaderFlags.Carry(document, Bit);
}
