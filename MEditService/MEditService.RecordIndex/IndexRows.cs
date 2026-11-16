using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;

namespace MEditService.RecordIndex;

// ADR-0012.
internal sealed record ReferenceRow(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);

/// <summary>A copy's document as the record index stores it, and whether its plugin has plugin source.</summary>
internal sealed record CopyHoldingText(string FormKey, PluginAddress Plugin, string RecordType, string? EditorId, string Body, bool InPluginSource);

/// <summary>A name a copy's document holds, and whether its plugin has plugin source.</summary>
internal sealed record NamedAt(PluginAddress Plugin, bool InPluginSource, DocumentNameRow Row);

internal record struct FormReferenceRow(
    string SourceFormKey,
    string TargetFormKey,
    string FieldPath,
    string RecordType,
    string? EditorId);

/// <summary>A script or a file a record's document names, at <paramref name="FieldPath"/>. A path no file can be named for
/// has no <paramref name="Name"/>, and says why.</summary>
internal sealed record DocumentNameRow(
    string FormKey, string RecordType, string? EditorId, DocumentNameKind Kind, string FieldPath, string? Name, string? Refusal);

/// <summary>A link in <paramref name="Plugin"/>'s record <paramref name="FormKey"/> (an inline child
/// under its own) to <paramref name="TargetFormKey"/>, which no active plugin holds.</summary>
internal sealed record MissingReference(
    PluginAddress Plugin, string FormKey, string RecordType, string? EditorId, string TargetFormKey, string FieldPath);

/// <summary>One malformed-plugin diagnosis the Index projected from a plugin's binary, in the
/// binary's record order.</summary>
internal sealed record PluginDiagnosisRow(PluginAddress Plugin, PluginDiagnosis Diagnosis);

// Flat row for a cell in its blocks. BlockX/Y and SubX/Y are null for a worldspace's TopCell; an
// interior cell's block and sub-block are one number each, in BlockX and SubX.
internal sealed record CellLocationSummary(
    string FormKey, string? EditorId,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? CellX, int? CellY,
    WorkingTreeState WorkingTreeState,
    string? FullName = null, bool HasParseFailure = false, string? ParseDiagnosis = null, bool HasChildren = false);
