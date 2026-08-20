namespace MEditService.Core.Records;

/// <summary>
/// One child record's parent slot, for the five <see cref="Ledger.ContainerStripFields"/>
/// relationships <see cref="PlacementWalker"/> doesn't already cover (#416 S1b):
/// <c>Cell.NavigationMeshes</c>, <c>Cell.Landscape</c>, <c>Quest.DialogBranches</c>,
/// <c>Quest.DialogTopics</c>, <c>DialogTopic.Responses</c>. <c>Cell.Persistent</c>/<c>Temporary</c>
/// and <c>Worldspace.TopCell</c>/<c>SubCells</c> stay exclusively on <see cref="PlacementRow"/>/
/// <see cref="CellLocationRow"/> — this table is additive, not a migration of what those already
/// carry.
///
/// <para><b>Ref-invariant by construction, not by omission</b>: no gesture in this arc can move a
/// record between containers or reorder a container's children (the fields this reads are exactly
/// the ones <c>ContainerStripFields</c> makes read-only by stripping them out of the ledger before
/// anyone can edit them), so this answers identically at every <see cref="RecordRef"/> the same way
/// <see cref="IRecordReads.GetPlacement"/> already does. A future gesture that *does* let a user
/// move a record between containers must either make this read ref-aware or move containment into
/// ledger text — ADR-0041's 2026-08-19 amendment already defers exactly this class of design
/// question ("multi-plugin editing complications... deliberately deferred; when that design happens,
/// it happens at compile") to the moment a real need for it exists.</para>
/// </summary>
public readonly record struct ContainerChildRow(
    string ChildFormKey, string ParentFormKey, string ParentRecordType, string SlotName, int SlotIndex);
