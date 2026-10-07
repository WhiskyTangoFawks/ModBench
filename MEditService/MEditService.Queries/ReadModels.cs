using System.Text.Json.Serialization;
using MEditService.Codec.Schema;

namespace MEditService.Queries;

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);

// ADR-0012.
public record RecordSummary(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    string Origin,
    WorkingTreeState WorkingTreeState = WorkingTreeState.None,
    // Whether at least one container_child row names this FormKey as parent: the Plugins tree's
    // expand chevron for a qust/dial row.
    bool HasContainerChildren = false,
    // Non-null when ingest could not turn this record into its document, so a listing never omits
    // one silently.
    string? ParseDiagnosis = null,
    // The same fact widened to this row's subtree, so the tree never walks children to aggregate.
    bool HasParseFailure = false,
    string? FullName = null);

// A tri-state rather than two booleans: the states are mutually exclusive. Deleted is absent
// because a working-tree-deleted record has no row to describe.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WorkingTreeState { None, Modified, Added }

/// <summary>Value is the stored document's own node for this field, verbatim, or null when the
/// document omits the member (which the codec does for a member equal to its default).</summary>
public record FieldValue(FieldMetadata Metadata, object? Value, string? CheckError = null);

public record CellChildRecords(
    IReadOnlyList<ChildRecordSummary> Persistent,
    IReadOnlyList<ChildRecordSummary> Temporary);

public record ChildRecordSummary(
    string FormKey, string? EditorId, string? BaseFormKey, string RecordType, WorkingTreeState WorkingTreeState,
    bool HasParseFailure = false, string? FullName = null, string? BaseEditorId = null, string? ParseDiagnosis = null);

// IsPersistentWorldspaceCell is the cell a Worldspace's TopCell slot names (xEdit's "<Persistent
// Worldspace Cell>"). FullName stays a separate fact: xEdit's GetDisplayName checks FULL first,
// unconditionally, so the tree provider needs both.
public record CellSummary(
    string FormKey, string? EditorId, int? CellX, int? CellY, WorkingTreeState WorkingTreeState,
    bool IsPersistentWorldspaceCell = false, string? FullName = null, bool HasParseFailure = false,
    string? ParseDiagnosis = null, bool HasChildren = false);
