namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 18, "Compressed", in every game.</summary>
public static class CompressedFlag
{
    /// <summary>Mutagen's Constants.CompressedFlag, which Mutagen keeps internal.</summary>
    public const int Bit = 0x0004_0000;
}
