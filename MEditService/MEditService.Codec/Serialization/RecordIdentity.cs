namespace MEditService.Codec.Serialization;

/// <summary>What a record is located by: the FormKey is the identity, the record type names its
/// group folder, and the EditorID names its file, so a stale EditorID costs a scan rather than a
/// wrong answer.</summary>
public readonly record struct RecordIdentity(string FormKey, string RecordType, string? EditorId);
