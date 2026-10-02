namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 10, "Persistent", on a placed record in every game, and the two
/// groups of its cell it chooses between: Mutagen's Cell members of those names in every game.</summary>
public static class PersistentFlag
{
    /// <summary>Mutagen's Constants.Persistent, which Mutagen keeps internal.</summary>
    public const int Bit = 0x0000_0400;

    public const string PersistentGroup = "Persistent";

    public const string TemporaryGroup = "Temporary";
}
