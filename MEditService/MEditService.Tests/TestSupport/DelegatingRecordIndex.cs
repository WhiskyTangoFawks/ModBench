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
    public virtual void ApplyRenumber(PluginKey key, RenumberedRecord renumbered) =>
        Inner.ApplyRenumber(key, renumbered);
    public virtual void CreateCellLocation(PluginKey plugin, CellLocationRow row) => Inner.CreateCellLocation(plugin, row);
    public virtual void Dispose() => Inner.Dispose();

    public virtual IRecordReads At(RecordRef recordRef) => Inner.At(recordRef);
}
