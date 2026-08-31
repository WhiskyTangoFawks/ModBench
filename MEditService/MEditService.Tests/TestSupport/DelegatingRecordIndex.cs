using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests;

/// <summary>
/// Forwards every <see cref="IRecordIndex"/> member to a real one, so a test double only has to
/// state the member it actually cares about. The interface is wide (indexing plus every read path),
/// and a double that reimplements it is both a maintenance burden and a lie — these tests want real
/// DuckDB behaviour with one seam intercepted, not a fake database.
/// </summary>
internal abstract class DelegatingRecordIndex(IRecordIndex inner) : IRecordIndex
{
    protected IRecordIndex Inner { get; } = inner;

    public virtual void SetFilter(string? sql) => Inner.SetFilter(sql);
    public virtual void Initialize(GameRelease release) => Inner.Initialize(release);

    public virtual void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null) =>
        Inner.Index(plugin, registration, key, filePath);
    public virtual string? IndexedContentHash(PluginKey key) => Inner.IndexedContentHash(key);
    public virtual void Unindex(PluginKey key) => Inner.Unindex(key);
    public virtual void Register(PluginKey key, Registration registration) =>
        Inner.Register(key, registration);
    public virtual void Unregister(PluginKey key) => Inner.Unregister(key);
    public virtual void UpdateWinners() => Inner.UpdateWinners();
    public virtual IReadOnlyList<PluginKey> RegisteredPlugins() => Inner.RegisteredPlugins();
    public virtual void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas) =>
        Inner.ApplyWorkingTreeChanges(key, deltas);
    public virtual void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body) =>
        Inner.CreateWorkingTreeRecord(key, formKey, recordType, body);
    public virtual void SetCommittedBaseline(PluginKey key, IReadOnlyList<(string FormKey, string Body)> baselines) =>
        Inner.SetCommittedBaseline(key, baselines);
    public virtual void MarkWorkingTreeOnly(PluginKey key, IReadOnlyList<string> formKeys) =>
        Inner.MarkWorkingTreeOnly(key, formKeys);
    public virtual void SeedCommittedOnly(PluginKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records) =>
        Inner.SeedCommittedOnly(key, records);
    public virtual void ReplaceContainerChildSlot(
        PluginKey key, string parentFormKey, string parentRecordType, string slotName,
        IReadOnlyList<(string ChildFormKey, int SlotIndex)> children) =>
        Inner.ReplaceContainerChildSlot(key, parentFormKey, parentRecordType, slotName, children);
    public virtual void RepointContainerChildParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
        Inner.RepointContainerChildParent(key, oldParentFormKey, newParentFormKey);
    public virtual void RepointCellLocationParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
        Inner.RepointCellLocationParent(key, oldParentFormKey, newParentFormKey);
    public virtual void CreateCellLocation(PluginKey plugin, CellLocationRow row) => Inner.CreateCellLocation(plugin, row);
    public virtual void Dispose() => Inner.Dispose();

    public virtual IRecordReads At(RecordRef recordRef) => Inner.At(recordRef);
    public RecordDocument? GetDocument(string formKey) => Inner.GetDocument(formKey);
    public RecordDocument? GetDocument(string formKey, PluginKey plugin) => Inner.GetDocument(formKey, plugin);
    public IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin) => Inner.GetDocuments(plugin);
    public RecordOverrides? GetOverrideStack(string formKey) => Inner.GetOverrideStack(formKey);
    public PagedResult<RecordSummary> Search(RecordQuery query) => Inner.Search(query);
    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) => Inner.GetRecordTypeCounts(plugin);
    public RecordLookupEntry? Resolve(string formKey) => Inner.Resolve(formKey);
    public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => Inner.GetReferencedBy(targetFormKey);
    public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
        Inner.GetPluginsWithMatchingRecords(tableNames);
    public IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin) => Inner.GetNativeFormKeys(plugin);
    public IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin) => Inner.GetEffectiveMasters(plugin);
    // Virtual so a test can inject an anomalous second block-less cell-location row
    // without reimplementing the rest of the wide IRecordIndex surface.
    public virtual IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey) =>
        Inner.GetWorldspaceCells(plugin, worldspaceFormKey);
    public PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int limit, int offset) =>
        Inner.GetInteriorCells(plugin, limit, offset);
    public CellReferences GetCellReferences(PluginKey plugin, string cellFormKey) =>
        Inner.GetCellReferences(plugin, cellFormKey);
    public PlacementRow? GetPlacement(string formKey, PluginKey plugin) => Inner.GetPlacement(formKey, plugin);
    public CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) => Inner.GetCellLocation(plugin, cellFormKey);
    public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey) =>
        Inner.GetContainerChildren(plugin, parentFormKey);
    public ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) =>
        Inner.GetContainerParent(plugin, childFormKey);
}
