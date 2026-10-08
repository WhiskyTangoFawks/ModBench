using System.Text.Json;

namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 10, "Persistent", on every game's placed records, and the two cell
/// groups it chooses between, by the names of Mutagen's Cell members. Oblivion's cell has a third,
/// Visible When Distant, group.</summary>
public static class PersistentFlag
{
    /// <summary>Mutagen's Constants.Persistent, which Mutagen keeps internal.</summary>
    public const int Bit = 0x0000_0400;

    public const string PersistentGroup = "Persistent";

    public const string TemporaryGroup = "Temporary";

    internal static bool IsSet(JsonElement document) => RecordHeaderFlags.Carry(document, Bit);
}
