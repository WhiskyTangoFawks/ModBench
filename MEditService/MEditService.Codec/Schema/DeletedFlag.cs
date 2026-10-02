using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 5, "Deleted", in every game.</summary>
public static class DeletedFlag
{
    /// <summary>Mutagen's Constants.DeletedFlag, which Mutagen keeps internal.</summary>
    public const int Bit = 0x0000_0020;

    /// <summary>The document member the record header's flags travel in.</summary>
    public const string FlagsMember = nameof(IMajorRecordGetter.MajorRecordFlagsRaw);
}
