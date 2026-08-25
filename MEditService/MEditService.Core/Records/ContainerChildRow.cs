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
///
/// <para><b>#453 is the gesture that paragraph anticipated, and the footing held — deliberately.</b>
/// A field edit can now reach a container's own document and an embedded child's fields, so a cell's
/// source text really is edited in a live session. This table survives because that gesture never
/// changes the <i>set</i> of children: <c>Edits.RecordEditService</c>'s own containment guard refuses
/// the child-slot columns outright (<c>Cell.{Landscape,NavigationMeshes}</c> and
/// <c>Worldspace.{TopCell,SubCells}</c> all reflect as ordinary writable columns, and writing one
/// would swap a container's children through a JSON blob), so parentage and slot order stay untouched
/// by anything on the write path.
///
/// <para><b>#461 is the gesture that footing named, and it did not hold — by ruling, not by
/// accident.</b> Delete and Renumber genuinely change the child set (removing an embedded child from
/// its owner's inline list; changing one's FormKey in place), and this table (alongside
/// <see cref="PlacementRow"/>/<see cref="CellLocationRow"/>) is <b>not</b> updated by either — they go
/// through <c>IRecordIndex.ApplyWorkingTreeChanges</c>/<c>CreateWorkingTreeRecord</c>, which re-derive
/// only <c>form_lookup</c>/<c>form_references</c>, the same as #427's <c>CreateRecord</c> already left
/// unfixed. Deliberately out of #461's scope — extending the derivation machinery to cover these three
/// tables is a bigger change than that ticket's mechanics warrant, and it does not affect <b>compile</b>,
/// which stopped reading them at all back in #454 (it deserializes the on-disk source tree directly).
/// It does affect any live read within the same session that consults these tables directly before a
/// reload/re-Track re-ingests the tree — tracked as its own follow-up,
/// <see href="https://github.com/WhiskyTangoFawks/ModBench/issues/488">#488</see>, rather than left to
/// evaporate as an undocumented gap.</para>
/// </summary>
public readonly record struct ContainerChildRow(
    string ChildFormKey, string ParentFormKey, string ParentRecordType, string SlotName, int SlotIndex);
