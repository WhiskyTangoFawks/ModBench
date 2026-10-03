using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>The members of a record's document that more than one module reads, spelled once: the codec writes these
/// names and every reader outside it matches on them.</summary>
public static class RecordMembers
{
    public const string FormKey = "FormKey";

    public const string EditorId = nameof(IMajorRecordGetter.EditorID);

    public const string FormVersion = nameof(IMajorRecordGetter.FormVersion);

    public const string VersionControlInfo1 = nameof(IMajorRecordGetter.VersionControl);

    // Each game from Fallout 3 on declares it on its own major record base, so no shared getter names it.
    public const string VersionControlInfo2 = "Version2";
}
