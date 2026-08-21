namespace MEditService.Core.Records;

/// <summary>
/// One child record's parent slot, for the <see cref="Source.ContainerChildFields"/> relationships
/// <see cref="PlacementWalker"/> doesn't already cover (#416 S1b): <c>Cell.NavigationMeshes</c>,
/// <c>Cell.Landscape</c>, <c>Quest.DialogBranches</c>, <c>Quest.DialogTopics</c>,
/// <c>Quest.Scenes</c>, <c>DialogTopic.Responses</c>. <c>Cell.Persistent</c>/<c>Temporary</c> and
/// <c>Worldspace.TopCell</c>/<c>SubCells</c> stay exclusively on <see cref="PlacementRow"/>/
/// <see cref="CellLocationRow"/> — this table is additive, not a migration of what those already
/// carry. (This list said "five" and omitted <c>Quest.Scenes</c> until #450; #416 added Scenes to
/// the table without updating the count here. The set is whatever
/// <c>ContainerChildFields.ByTypeName</c> holds minus
/// <c>DuckDbRecordIndex.CoveredByPlacementTables</c> — six today.)
///
/// <para><b><see cref="SlotIndex"/> is load-bearing, not bookkeeping.</b> For the folder-split
/// relationships it is the <i>only</i> surviving record of a child's position in its parent's list:
/// those children are written to their own files and read back with the parent's slot empty, so
/// <c>ContainerAssembler</c> has nothing else to reconstruct the order from at compile. Dropping it
/// there reorders a quest's dialog topics in the compiled plugin, silently
/// (<c>ContainerAssemblerOrderingTests</c>).</para>
///
/// <para><b>Ref-invariant, though less by construction than it was</b>: no gesture in this arc moves
/// a record between containers or reorders a container's children, so this answers identically at
/// every <see cref="RecordRef"/>, the same way <see cref="IRecordReads.GetPlacement"/> does. Note
/// what changed under #450: the guarantee used to rest on <c>ContainerStripFields</c> hollowing these
/// slots out of the source before anyone could reach them, and that strip is gone — the embedded
/// slots (<c>Cell.NavigationMeshes</c>/<c>Landscape</c>) are now present in the cell's own source
/// text. What holds the invariant up today is only that no gesture edits them, which is a weaker
/// footing than "they are not there". A gesture that does — or a hand edit to a cell's source file —
/// must make this read ref-aware or move containment into the source outright, which is what
/// ADR-0041's #444 amendment already points at ("containment is the path").</para>
/// </summary>
public readonly record struct ContainerChildRow(
    string ChildFormKey, string ParentFormKey, string ParentRecordType, string SlotName, int SlotIndex);
