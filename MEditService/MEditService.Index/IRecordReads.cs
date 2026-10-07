using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>Every read the index answers. A record read
/// sees only the active plugins (ADR-0012); a plugin's own facts answer while the
/// snapshot names it.</summary>
public interface IRecordReads
{
    /// <summary>What the Index read out of each plugin it has open, keyed by identity. A plugin it has
    /// not reached, or could not open, is absent, so this is also "which plugins are open?".
    /// </summary>
    IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins { get; }

    /// <summary>The winning override of <paramref name="formKey"/>, across every active
    /// plugin. Null if the FormKey isn't indexed.</summary>
    RecordDocument? GetDocument(string formKey);

    /// <summary>One specific plugin's copy of <paramref name="formKey"/>, winner or not. Null if
    /// that plugin never indexed this FormKey.</summary>
    RecordDocument? GetDocument(string formKey, PluginAddress plugin);

    /// <summary>The copy <paramref name="plugin"/> would hold were its document <paramref name="text"/>,
    /// active or not. Null if no plugin indexes the FormKey. Text that is no record document gives
    /// a copy with a <c>ParseDiagnosis</c>.</summary>
    RecordDocument? DocumentFromText(string formKey, PluginAddress plugin, int loadOrderIndex, string text);

    /// <summary>Every document <paramref name="plugin"/> holds, in one bulk read, for consumers that
    /// scan a whole plugin and would otherwise pay two point queries per record.</summary>
    IReadOnlyList<RecordDocument> GetDocuments(PluginAddress plugin);

    /// <summary>Every plugin's copy of <paramref name="formKey"/>, in load order. Null if the
    /// FormKey isn't indexed anywhere.</summary>
    RecordOverrides? GetOverrideStack(string formKey);

    PagedResult<RecordSummary> Search(RecordQuery query);

    /// <summary>Row count per record type for one plugin — a single grouped query replacing a
    /// per-type loop.</summary>
    IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin);

    /// <summary>O(1) FormKey → (record type, EditorID) lookup against the winning override,
    /// backed by <c>form_lookup</c>.</summary>
    RecordLookupEntry? Resolve(string formKey);

    /// <summary>One response's <see cref="Resolve"/> about <paramref name="formKey"/>, each distinct
    /// FormKey asked once. The store resolves the links its copies carry in one query up front.</summary>
    Func<string, RecordLookupEntry?> LinkResolver(string formKey) => FormKeyResolutionCache.Memoize(Resolve);

    IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey);

    /// <summary>Every link an active plugin's record carries to a FormKey no active plugin holds,
    /// except the engine-defined FormIds the grid's dangling warning also exempts.</summary>
    IReadOnlyList<MissingReference> GetReferencesToMissingRecords();

    /// <summary><see cref="GetReferencesToMissingRecords"/>, each with its referring record's file in
    /// the tree <paramref name="modOf"/> names for its plugin, null for a plugin no mod folder provides.</summary>
    IReadOnlyList<MissingReferenceOnFile> GetReferencesToMissingRecordsOnFiles(
        Func<PluginAddress, PluginProvider.FromMod?> modOf);

    /// <summary>Every plugin at least one filtered record matches, restricted to
    /// <paramref name="tableNames"/> (plugins.md). Empty when no filter is active: every plugin
    /// already has matches.</summary>
    IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames);

    /// <summary>Every Kind B diagnosis the registered plugins' binaries prove, projected when each
    /// binary was hashed and gone with its rows: the malformed-plugin read.</summary>
    IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses();

    /// <summary>What each registered plugin's rows were derived from. A plugin with no rows is absent.</summary>
    IReadOnlyDictionary<PluginAddress, DerivedFrom> GetDerivations();

    /// <summary>Every plugin holding at least one record Mutagen could not read, as
    /// <c>ColumnKey.Of(name, origin)</c> values: the tree's "has a failure below it" for a plugin
    /// row, answered from the page it already has.</summary>
    IReadOnlySet<string> GetPluginsWithParseFailures();

    // Worldspace tree reads (plugins.md, The tree, story 6) from the placement / cell_location side
    // tables, in the order xEdit's navigator lists them.
    IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey);
    IReadOnlyList<CellLocationSummary> GetInteriorCells(PluginAddress plugin);
    CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey);
    IReadOnlySet<string> GetWorldspacesHoldingCells(PluginAddress plugin);

    /// <summary>A placed ref's structural parentage (cell, persistent/temporary, position). Null
    /// when not placed.</summary>
    PlacementRow? GetPlacement(string formKey, PluginAddress plugin);

    /// <summary>One cell's own structural parentage, or null when it isn't a cell this plugin
    /// indexed. Ref-invariant like <see cref="GetPlacement"/>: no gesture moves a cell.</summary>
    CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey);

    /// <summary><paramref name="parentFormKey"/>'s children among the relationships the placement
    /// reads don't carry (see <see cref="ContainerChildRow"/>), in FormID order; empty when it has
    /// none. Ref-invariant by construction.</summary>
    IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey);

    /// <summary>Whether <paramref name="plugin"/> holds a record below <paramref name="formKey"/>: a
    /// topic in its quest, a cell in its worldspace, a placed reference in its cell. Unfiltered: a
    /// copy takes every child record, whatever the listing shows.</summary>
    bool HasChildRecords(PluginAddress plugin, string formKey);

    /// <summary>Every plugin holding at least one record below <paramref name="formKey"/> as
    /// <paramref name="plugin"/> holds it, at any depth, whether or not it holds the record itself.</summary>
    IReadOnlySet<PluginAddress> PluginsHoldingChildRecords(PluginAddress plugin, string formKey);

    /// <summary>The one parent slot <paramref name="childFormKey"/> sits in, or null. Needed because
    /// an embedded child has no file of its own; a placed reference answers null here and through
    /// <see cref="GetPlacement"/> instead.</summary>
    ContainerChildRow? GetContainerParent(PluginAddress plugin, string childFormKey);
}
