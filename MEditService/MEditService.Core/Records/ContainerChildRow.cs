namespace MEditService.Core.Records;

/// <summary>
/// One child record's parent slot, for the <see cref="Source.ContainerChildFields"/> relationships
/// <see cref="PlacementWalker"/> doesn't already cover: <c>Cell.NavigationMeshes</c>,
/// <c>Cell.Landscape</c>, <c>Quest.DialogBranches</c>, <c>Quest.DialogTopics</c>,
/// <c>Quest.Scenes</c>, <c>DialogTopic.Responses</c> — the set is whatever
/// <c>ContainerChildFields.ByTypeName</c> holds minus
/// <c>DuckDbRecordIndex.CoveredByPlacementTables</c>. <c>Cell.Persistent</c>/<c>Temporary</c> and
/// <c>Worldspace.TopCell</c>/<c>SubCells</c> stay exclusively on <see cref="PlacementRow"/>/
/// <see cref="CellLocationRow"/> — this table is additive, not a migration of what those already
/// carry.
///
/// <para><see cref="SlotIndex"/> is the child's real GRUP position: <c>RecordTextCodecCustomization</c>
/// turns <c>Overall.EnforceRecordOrder</c> on, so every folder-split sibling's file name carries its
/// GRUP position in a <c>"[N] "</c> prefix and this column is that position — exact against the
/// binary a tracked plugin came from, not just self-consistent across re-reads of one tree.</para>
///
/// <para><b>No Head dimension, ever.</b> Unlike <c>records</c>, this table (alongside
/// <see cref="PlacementRow"/>/<see cref="CellLocationRow"/>) carries no <see cref="RecordRef"/>
/// column — it names Effective containment only, the same documented contract
/// <see cref="IRecordReads.GetPlacement"/> answers under.</para>
///
/// <para>A field edit can never change a child <i>set</i>: <c>Edits.RecordEditService</c>'s
/// containment guard refuses the child-slot columns outright (<c>Cell.{Landscape,NavigationMeshes}</c>
/// and <c>Worldspace.{TopCell,SubCells}</c> all reflect as ordinary writable columns, and writing one
/// would swap a container's children through a JSON blob), so field edits leave this table nothing to
/// re-derive.</para>
///
/// <para>Delete/renumber/create do change the set. <c>IRecordIndex.ApplyWorkingTreeChanges</c>/
/// <c>CreateWorkingTreeRecord</c> re-derive this table exactly the way they do
/// <c>form_lookup</c>/<c>form_references</c>: whenever a parent's own document is reserialized (an
/// embedded delete or renumber splices/mutates its child list in place), <c>DuckDbRecordIndex</c>
/// rebuilds every row for that parent from <c>Source.ContainerChildFields.EnumerateChildren</c> — the
/// same collector ingest's own <c>AppendDocument</c> uses — so a stale or missing child is a
/// contradiction the next write already repairs, not a state a reader has to defend against. A
/// folder-split child (a Quest's DialogTopic, a DialogTopic's Response) has no parent document to
/// reserialize at all, so its own slot is told explicitly instead, via
/// <c>IRecordIndex.ReplaceContainerChildSlot</c>, computed the same way
/// <c>SourceUnitResolver.RenormalizeGroupOrder</c> closes the matching gap in the tree's own
/// <c>"[N]"</c> file-name prefixes. The alternative — making every reader of this table
/// existence-check against <c>records</c> instead — was rejected: it would have turned "these tables
/// track Effective" into a documented falsehood every future reader has to remember, rather than an
/// invariant the write path upholds.</para>
///
/// <para>Renumbering a folder-split container (a Quest, a DialogTopic) keeps its children's FormKeys
/// and files untouched — only the parent's own directory name (and therefore FormKey) changes — so
/// their rows would still name the <i>old</i> parent FormKey, and re-deriving the parent's own
/// (now-new-FormKey) document cannot repair them: a folder-split child is never embedded in its
/// parent's document. <c>IRecordIndex.ApplyRenumber</c> re-points them with an <c>UPDATE</c>, run
/// before the old FormKey's own rows are torn down and inside the same transaction, so a renamed
/// container's children are never merely deleted out from under it. Still open: a renumbered folder-split
/// record's <i>own</i> row as somebody else's child (its position in <i>its</i> parent's slot) — the
/// general "another record's stale pointer into a renamed record" question, not this table's own
/// accounting of its own children.</para>
/// </summary>
public readonly record struct ContainerChildRow(
    string ChildFormKey, string ParentFormKey, string ParentRecordType, string SlotName, int SlotIndex);
