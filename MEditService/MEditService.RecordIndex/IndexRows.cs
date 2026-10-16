using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;

namespace MEditService.RecordIndex;

// ADR-0012.
internal sealed record ReferenceRow(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);

internal record struct FormReferenceRow(
    string SourceFormKey,
    string TargetFormKey,
    string FieldPath,
    string RecordType,
    string? EditorId);

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
