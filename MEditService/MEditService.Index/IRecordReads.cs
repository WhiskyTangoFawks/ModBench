using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>Every read the index answers, at the caller's <see cref="RecordRef"/> (ADR-0009
/// invariant 1). A plugin's own facts answer while the snapshot names it.</summary>
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
    /// backed by <c>form_lookup</c> (ADR-0011).</summary>
    RecordLookupEntry? Resolve(string formKey);

    /// <summary>One response's <see cref="Resolve"/> about <paramref name="formKey"/>: the links its
    /// copies carry resolve in one query up front, any other FormKey alone (ADR-0005 invariant
    /// 6).</summary>
    Func<string, RecordLookupEntry?> LinkResolver(string formKey) => FormKeyResolutionCache.Memoize(Resolve);

    IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey);

    /// <summary>Every plugin at least one filtered record matches, restricted to
    /// <paramref name="tableNames"/> (plugins.md). Empty when no filter is active: every plugin
    /// already has matches.</summary>
    IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames);

    /// <summary>Every Kind B diagnosis the registered plugins' binaries prove, projected when each
    /// binary was hashed and gone with its rows: the malformed-plugin read.</summary>
    IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses();

    /// <summary>The registered plugins whose rows were derived from a source tree: tracked, as the
    /// Index knows it. A plugin derived from its binary is absent.</summary>
    IReadOnlySet<PluginAddress> GetTrackedPlugins();

    /// <summary>Every plugin holding at least one record Mutagen could not read, as
    /// <c>ColumnKey.Of(name, origin)</c> values: the tree's "has a failure below it" for a plugin
    /// row, answered from the page it already has.</summary>
    IReadOnlySet<string> GetPluginsWithParseFailures();

    /// <summary>FormKeys native to <paramref name="plugin"/> (the FormKey's own ModKey is this
    /// plugin) — ESL-eligibility validation.</summary>
    IReadOnlyList<string> GetNativeFormKeys(PluginAddress plugin);

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

    /// <summary>The one parent slot <paramref name="childFormKey"/> sits in, or null. Needed because
    /// an embedded child has no file of its own; a placed reference answers null here and through
    /// <see cref="GetPlacement"/> instead.</summary>
    ContainerChildRow? GetContainerParent(PluginAddress plugin, string childFormKey);
}
