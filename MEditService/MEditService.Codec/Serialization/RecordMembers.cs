namespace MEditService.Codec.Serialization;

/// <summary>The two members every record's document carries, spelled once: the codec writes these
/// names and every reader outside it matches on them.</summary>
public static class RecordMembers
{
    public const string FormKey = "FormKey";

    public const string EditorId = "EditorID";
}
