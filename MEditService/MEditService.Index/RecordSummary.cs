namespace MEditService.Index;

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
