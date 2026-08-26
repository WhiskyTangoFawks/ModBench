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
/// <para><b><see cref="SlotIndex"/> no longer feeds compile</b> (#454). It used to be the ordering
/// source <c>ContainerAssembler</c> rebuilt a folder-split slot from; that class is gone, because
/// containment — and with it the child set — is now the tree's own directory nesting, read by the
/// whole-mod deserializer.
///
/// <para><b>#459: child order is canonical again, not merely stable.</b> This used to say the order
/// was lost — the pre-#459 layout carried none (its reader sorts on a <c>"[N] "</c> file-name prefix
/// written only under <c>Overall.EnforceRecordOrder</c>, which neither this project nor Spriggit ever
/// turned on), so this column held whatever order the tree happened to be read in, not the original
/// binary's GRUP order. <c>RecordTextCodecCustomization</c> now turns that flag on, so every
/// folder-split sibling's file name carries its real GRUP position and this column is that position —
/// exact against the binary a tracked plugin came from, not just self-consistent across re-reads of
/// one tree. No longer allowlisted by <c>SourceIngestParityTests</c>: that tolerance is gone, not
/// widened.</para>
///
/// <para><b>Ref-invariant in the sense that matters: no Head dimension, ever.</b> Unlike <c>records</c>,
/// this table (alongside <see cref="PlacementRow"/>/<see cref="CellLocationRow"/>) carries no
/// <see cref="RecordRef"/> column and never will — it names Effective containment only, the same
/// documented contract <see cref="IRecordReads.GetPlacement"/> answers under. #453 and #461 below are
/// about a different question: whether Effective's own rows stay <i>correct</i> as gestures land, not
/// whether a Head/ref split gets added.</para>
///
/// <para><b>#453 changed nothing here, deliberately.</b> A field edit can reach a container's own
/// document and an embedded child's fields, so a cell's source text really is edited in a live
/// session — but <c>Edits.RecordEditService</c>'s own containment guard refuses the child-slot columns
/// outright (<c>Cell.{Landscape,NavigationMeshes}</c> and <c>Worldspace.{TopCell,SubCells}</c> all
/// reflect as ordinary writable columns, and writing one would swap a container's children through a
/// JSON blob), so no field edit can change a child <i>set</i> at all, and this table has nothing to
/// re-derive on that path.</para>
///
/// <para><b>#461 (Delete/Renumber) and #427 (Create) do change the set, and #488 closes the gap that
/// opened — direction 1 of the two the issue posed, not direction 2.</b> <c>IRecordIndex.ApplyWorkingTreeChanges</c>/
/// <c>CreateWorkingTreeRecord</c> now re-derive this table exactly the way they already did
/// <c>form_lookup</c>/<c>form_references</c>: whenever a parent's own document is reserialized (an
/// embedded delete or renumber splices/mutates its child list in place), <c>DuckDbRecordIndex</c>
/// rebuilds every row for that parent from <c>Source.ContainerChildFields.EnumerateChildren</c> — the
/// same collector ingest's own <c>AppendDocument</c> uses — so a stale or missing child is a
/// contradiction the next write already repairs, not a state a reader has to defend against. A
/// folder-split child (a Quest's DialogTopic, a DialogTopic's Response) has no parent document to
/// reserialize at all, so its own slot is told explicitly instead, via
/// <c>IRecordIndex.ReplaceContainerChildSlot</c>, computed the same way
/// <c>SourceUnitResolver.RenormalizeGroupOrder</c> already closes the matching gap in the tree's own
/// <c>"[N]"</c> file-name prefixes. Direction 2 — making every reader of this table existence-check
/// against <c>records</c> instead — was considered and rejected: it would have turned "these tables
/// track Effective" into a documented falsehood every future reader has to remember, rather than an
/// invariant the write path upholds.</para>
/// </summary>
public readonly record struct ContainerChildRow(
    string ChildFormKey, string ParentFormKey, string ParentRecordType, string SlotName, int SlotIndex);
