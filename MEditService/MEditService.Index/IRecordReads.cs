using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>Every read the index answers, at whichever <see cref="RecordRef"/> the caller is
/// positioned on. No table-name dispatch crosses this seam; VMAD/condition reconstitution lives in
/// <c>Queries/</c>, built from the document body.</summary>
public interface IRecordReads
{
    /// <summary>What the Index read out of each copy it has open, keyed by identity. A copy it has
    /// not reached, or could not open, is absent, so this is also "which copies are open?".
    /// </summary>
    IReadOnlyDictionary<PluginCopyKey, PluginContent> OpenedCopies { get; }

    /// <summary>The winning override of <paramref name="formKey"/>, across every participating
    /// plugin. Null if the FormKey isn't indexed.</summary>
    RecordDocument? GetDocument(string formKey);

    /// <summary>One specific plugin's copy of <paramref name="formKey"/>, winner or not. Null if
    /// that plugin never indexed this FormKey.</summary>
    RecordDocument? GetDocument(string formKey, PluginCopyKey plugin);

    /// <summary>Every document <paramref name="plugin"/> holds, in one bulk read, for consumers that
    /// scan a whole plugin and would otherwise pay two point queries per record.</summary>
    IReadOnlyList<RecordDocument> GetDocuments(PluginCopyKey plugin);

    /// <summary>Every plugin's copy of <paramref name="formKey"/>, in load order. Null if the
    /// FormKey isn't indexed anywhere.</summary>
    RecordOverrides? GetOverrideStack(string formKey);

    PagedResult<RecordSummary> Search(RecordQuery query);

    /// <summary>Row count per record type for one plugin — a single grouped query replacing a
    /// per-type loop.</summary>
    IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginCopyKey plugin);

    /// <summary>O(1) FormKey → (record type, EditorID) lookup against the winning override,
    /// backed by <c>form_lookup</c> (ADR-0005).</summary>
    RecordLookupEntry? Resolve(string formKey);

    IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey);

    /// <summary>Every plugin name at least one filtered record matches, restricted to
    /// <paramref name="tableNames"/> (plugins.md). Empty when no filter is active: every plugin
    /// already has matches.</summary>
    IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames);

    /// <summary>Every plugin holding at least one record Mutagen could not read, as
    /// <c>ColumnKey.Of(name, origin)</c> values: the tree's "has a failure below it" for a plugin
    /// row, answered from the page it already has.</summary>
    IReadOnlySet<string> GetPluginsWithParseFailures();

    /// <summary>Worldspace FormKeys with an unreadable cell, or an unreadable placed reference
    /// in one, somewhere below them: the worldspace row's "has a failure below it", which the
    /// container relation cannot answer.</summary>
    IReadOnlySet<string> GetWorldspacesWithFailuresBelow(PluginCopyKey plugin);

    /// <summary>FormKeys native to <paramref name="plugin"/> (the FormKey's own ModKey is this
    /// plugin) — ESL-eligibility validation.</summary>
    IReadOnlyList<string> GetNativeFormKeys(PluginCopyKey plugin);

    // Worldspace tree reads (ADR-0005) (from the placement / cell_location side tables).
    IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginCopyKey plugin, string worldspaceFormKey);
    PagedResult<CellSummary> GetInteriorCells(PluginCopyKey plugin, int limit, int offset);
    CellReferences GetCellReferences(PluginCopyKey plugin, string cellFormKey);

    /// <summary>A placed ref's structural parentage (cell, persistent/temporary, position). Null
    /// when not placed.</summary>
    PlacementRow? GetPlacement(string formKey, PluginCopyKey plugin);

    /// <summary>One cell's own structural parentage, or null when it isn't a cell this plugin
    /// indexed. Ref-invariant like <see cref="GetPlacement"/>: no gesture moves a cell.</summary>
    CellLocationRow? GetCellLocation(PluginCopyKey plugin, string cellFormKey);

    /// <summary><paramref name="parentFormKey"/>'s children among the relationships the placement
    /// reads don't carry (see <see cref="ContainerChildRow"/>), in slot order; empty when it has
    /// none. Ref-invariant by construction.</summary>
    IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginCopyKey plugin, string parentFormKey);

    /// <summary>The one parent slot <paramref name="childFormKey"/> sits in, or null. Needed because
    /// an embedded child has no file of its own; a placed reference answers null here and through
    /// <see cref="GetPlacement"/> instead.</summary>
    ContainerChildRow? GetContainerParent(PluginCopyKey plugin, string childFormKey);
}
