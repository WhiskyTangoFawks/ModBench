using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>Forwards every member to a real index so a double states only the member it cares
/// about: these tests want real DuckDB behaviour with one seam intercepted, not a fake database.</summary>
internal abstract class DelegatingRecordIndex(IRecordIndex inner) : IRecordIndex
{
    protected IRecordIndex Inner { get; } = inner;

    public virtual void SetFilter(string? sql) => Inner.SetFilter(sql);
    public virtual void RefreshByKeys(PluginKey key, string modFolder, IReadOnlyList<string> formKeys) =>
        Inner.RefreshByKeys(key, modFolder, formKeys);
    public virtual ValidationReport Validate(PluginKey key, string? modFolder) => Inner.Validate(key, modFolder);
    public virtual void Initialize(GameRelease release) => Inner.Initialize(release);
    public virtual long Sequence => Inner.Sequence;
    public virtual IDisposable BeginProjection() => Inner.BeginProjection();
    public virtual void Announce(Action publish) => Inner.Announce(publish);

    public virtual void Index(
        IPluginDocuments documents, Registration registration, PluginKey key, string? filePath = null) =>
        Inner.Index(documents, registration, key, filePath);
    public virtual string? IndexedContentHash(PluginKey key) => Inner.IndexedContentHash(key);
    public virtual void Unindex(PluginKey key) => Inner.Unindex(key);
    public virtual void Register(PluginKey key, Registration registration) =>
        Inner.Register(key, registration);
    public virtual void Unregister(PluginKey key) => Inner.Unregister(key);
    public virtual void UpdateWinners(IReadOnlyList<RegisteredCopy> participating) => Inner.UpdateWinners(participating);
    public virtual IReadOnlyList<PluginKey> RegisteredPlugins() => Inner.RegisteredPlugins();
    public virtual void SetCommittedBaseline(PluginKey key, IReadOnlyList<(string FormKey, string Body)> baselines) =>
        Inner.SetCommittedBaseline(key, baselines);
    public virtual void MarkWorkingTreeOnly(PluginKey key, IReadOnlyList<string> formKeys) =>
        Inner.MarkWorkingTreeOnly(key, formKeys);
    public virtual void SeedCommittedOnly(PluginKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records) =>
        Inner.SeedCommittedOnly(key, records);
    public virtual void Dispose() => Inner.Dispose();

    public virtual IRecordReads At(RecordRef recordRef) => Inner.At(recordRef);
}
