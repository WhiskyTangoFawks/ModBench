using MEditService.Core.Queries;

namespace MEditService.Core.Records;

/// <summary>
/// Every read the record index answers, at whichever <see cref="RecordRef"/> the caller is
/// positioned on (<see cref="IRecordIndex.At"/>) — the default surface of <see cref="IRecordIndex"/>
/// itself answers at <see cref="RecordRef.Effective"/>. Replaces <c>IRecordReader</c> (#421):
/// <c>GetRecord</c>/<c>GetAllOverrides</c> become <see cref="GetDocument(string)"/> and
/// <see cref="GetOverrideStack"/>; <c>GetRecords</c>/<c>SearchRecords</c> become
/// <see cref="Search"/>; <c>GetVmad</c>/<c>GetConditions</c>/<c>FindRecordType</c> and every
/// <c>tableName</c> dispatch parameter are rejected from the seam outright — VMAD/condition
/// reconstitution now lives in <c>Queries/</c>, built from <see cref="RecordDocument.Body"/> plus
/// the existing codecs.
/// </summary>
public interface IRecordReads
{
    /// <summary>The winning override of <paramref name="formKey"/>, across every participating
    /// plugin. Null if the FormKey isn't indexed.</summary>
    RecordDocument? GetDocument(string formKey);

    /// <summary>One specific plugin's copy of <paramref name="formKey"/>, winner or not. Null if
    /// that plugin never indexed this FormKey.</summary>
    RecordDocument? GetDocument(string formKey, PluginKey plugin);

    /// <summary>Every plugin's copy of <paramref name="formKey"/>, in load order. Null if the
    /// FormKey isn't indexed anywhere.</summary>
    RecordOverrides? GetOverrideStack(string formKey);

    PagedResult<RecordSummary> Search(RecordQuery query);

    /// <summary>Row count per record type for one plugin — a single grouped query replacing a
    /// per-type loop.</summary>
    IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin);

    /// <summary>Every FormKey with more than one override entry in its stack — the Conflicts
    /// node's candidate population (#364), before <c>IConflictClassifier</c> decides whether that
    /// multiplicity is an actual conflict or just an uncontested/benign override. Session-wide, not
    /// scoped to a plugin (a contested FormKey inherently spans more than one). Respects the active
    /// filter the same way every other filterable read here does (<c>BuildWhere</c>'s
    /// <c>filterActive</c>) — #278's already-shipped mechanism, not a second filter path.</summary>
    IReadOnlyList<string> GetContestedFormKeys();

    /// <summary>O(1) FormKey → (record type, EditorID) lookup against the winning override,
    /// backed by <c>form_lookup</c> (ADR-0031).</summary>
    RecordLookupEntry? Resolve(string formKey);

    IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey);

    /// <summary>Every distinct plugin name at least one indexed record's <c>form_key</c> or
    /// <c>_filter</c> row currently matches, restricted to <paramref name="tableNames"/> — powers
    /// the Plugins tree's filtered chevron (ADR-0035 amending ADR-0018). Empty when no filter is
    /// active: with nothing narrowing the listing, every plugin already has matches.</summary>
    IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames);

    /// <summary>FormKeys native to <paramref name="plugin"/> (the FormKey's own ModKey is this
    /// plugin) — ESL-eligibility validation (#85).</summary>
    IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin);

    /// <summary>
    /// The distinct master plugins <paramref name="plugin"/>'s content actually requires at this
    /// ref — <b>derived</b>, never the plugin's own declared header list (ADR-0038's "effective
    /// masters": committed masters unioned with the origin plugins everything the plugin's
    /// content, committed and (from #415) pending, actually references). A master a plugin
    /// declares but nothing in it references or overrides is not effective and is excluded.
    /// Computed as the union of (a) the owning plugin of every FormKey this plugin's records
    /// reference outward (<c>form_references</c>) and (b) the owning plugin of every FormKey this
    /// plugin carries that isn't native to it (an override forces that master) — in deterministic
    /// load-order order, excluding the plugin itself.
    /// </summary>
    IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin);

    // Worldspace tree reads (ADR-0023) (from the placement / cell_location side tables).
    IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey);
    PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int limit, int offset);
    CellReferences GetCellReferences(PluginKey plugin, string cellFormKey);

    /// <summary>A placed ref's structural parentage (cell, persistent/temporary, position). Null
    /// when not placed.</summary>
    PlacementRow? GetPlacement(string formKey, PluginKey plugin);

    /// <summary>
    /// One cell's own structural parentage — worldspace/block/sub/grid, or interior — the raw row
    /// <see cref="GetWorldspaceCells"/>/<see cref="GetInteriorCells"/> group into a UI-shaped tree.
    /// Null when <paramref name="cellFormKey"/> isn't a cell this plugin indexed. #416 S1b: the
    /// per-cell read compile's container assembler needs — ref-invariant the same way
    /// <see cref="GetPlacement"/> is, for the same reason (no gesture in this arc moves a cell).
    /// </summary>
    CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey);

    /// <summary>
    /// <paramref name="parentFormKey"/>'s children among the five <see cref="Source.ContainerChildFields"/>
    /// relationships <see cref="GetPlacement"/>/<see cref="GetWorldspaceCells"/> don't already carry
    /// (#416 S1b) — <c>Cell.NavigationMeshes</c>/<c>Landscape</c>, <c>Quest.DialogBranches</c>/
    /// <c>DialogTopics</c>, <c>DialogTopic.Responses</c> — in original slot order. Empty when
    /// <paramref name="parentFormKey"/> has none (including when it isn't one of those container
    /// types at all).
    ///
    /// <para><b>Ref-invariant by construction, not by omission</b> — see <see cref="ContainerChildRow"/>'s
    /// own doc comment for the invariant this leans on and what a future container-mutating gesture
    /// would have to change about it.</para>
    /// </summary>
    IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey);

    /// <summary>
    /// The inverse of <see cref="GetContainerChildren"/>: the one parent slot
    /// <paramref name="childFormKey"/> sits in, or null when it sits in none. #453's
    /// record→source-unit resolution needs the child→parent direction, because an embedded child has
    /// no file of its own and the only route to its bytes is through whichever container's document
    /// carries it inline.
    ///
    /// <para>Scoped to the same six relationships <see cref="GetContainerChildren"/> is, so a placed
    /// reference answers null here and through <see cref="GetPlacement"/> instead — the two tables
    /// stay additive rather than becoming two competing copies of one relationship (#416 S1b).</para>
    /// </summary>
    ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey);
}
