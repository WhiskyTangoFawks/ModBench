namespace MEditService.Core.Records;

// Origin (ADR-0012): additive alongside Plugin; without it two same-filename plugins listed
// together are indistinguishable rows.
public record RecordSummary(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    string Origin,
    // Defaults to None (test fixtures, GetOverrideStack's own unrelated read paths) — Search() is
    // the only real producer of a non-None value; see DuckDbRecordIndex.Search.
    WorkingTreeState WorkingTreeState = WorkingTreeState.None,
    // Whether at least one container_child row names this FormKey as parent — the Plugins tree's
    // expand chevron for a qust/dial row. Search() is the only producer of true; every
    // other construction site has nothing to report.
    bool HasContainerChildren = false,
    // Non-null when ingest could not turn this record into its document — the Mutagen read, the
    // reference walk or the codec write — so Search can never omit one silently.
    string? ParseDiagnosis = null,
    // The same fact widened to this row's subtree, so the tree never walks children to aggregate.
    bool HasParseFailure = false);
