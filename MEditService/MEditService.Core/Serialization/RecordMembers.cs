namespace MEditService.Core.Serialization;

/// <summary>The two members every record's document carries, spelled once: the codec writes these
/// names and every reader outside it matches on them.</summary>
internal static class RecordMembers
{
    internal const string FormKey = "FormKey";

    internal const string EditorId = "EditorID";
}
