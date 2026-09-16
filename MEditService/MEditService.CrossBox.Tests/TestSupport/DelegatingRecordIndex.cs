using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>Forwards every member to a real index so a double states only the member it cares
/// about: these tests want real DuckDB behaviour with one seam intercepted, not a fake database.</summary>
internal abstract class DelegatingRecordIndex(IRecordIndex inner) : IRecordIndex
{
    protected IRecordIndex Inner { get; } = inner;

    /// <summary>The store at the bottom of any stack of wrappers, for a test reading its rows
    /// directly.</summary>
    internal static DuckDbRecordIndex DuckDbUnder(IRecordIndex index) =>
        index switch
        {
            DuckDbRecordIndex duckDb => duckDb,
            DelegatingRecordIndex wrapper => DuckDbUnder(wrapper.Inner),
            _ => throw new InvalidOperationException($"No DuckDB store under {index.GetType().Name}."),
        };

    public virtual void SetFilter(string? sql) => Inner.SetFilter(sql);
    public virtual void RefreshByKeys(PluginCopyKey key, string modFolder, IReadOnlyList<string> formKeys) =>
        Inner.RefreshByKeys(key, modFolder, formKeys);
    public virtual ValidationReport Validate(PluginCopyKey key, string? modFolder) => Inner.Validate(key, modFolder);
    public virtual void Initialize(GameRelease release) => Inner.Initialize(release);
    public virtual void ReadOpenedCopiesFrom(Func<IReadOnlyDictionary<PluginCopyKey, PluginContent>> opened) =>
        Inner.ReadOpenedCopiesFrom(opened);
    public virtual long Sequence => Inner.Sequence;
    public virtual IDisposable BeginProjection() => Inner.BeginProjection();
    public virtual void Announce(Action publish) => Inner.Announce(publish);

    public virtual void Index(
        IPluginDocuments documents, Registration registration, PluginCopyKey key, string? filePath = null) =>
        Inner.Index(documents, registration, key, filePath);
    public virtual string? IndexedContentHash(PluginCopyKey key) => Inner.IndexedContentHash(key);
    public virtual void Unindex(PluginCopyKey key) => Inner.Unindex(key);
    public virtual void Register(PluginCopyKey key, Registration registration) =>
        Inner.Register(key, registration);
    public virtual void Unregister(PluginCopyKey key) => Inner.Unregister(key);
    public virtual void UpdateWinners(IReadOnlyList<RegisteredCopy> participating) => Inner.UpdateWinners(participating);
    public virtual IReadOnlyList<PluginCopyKey> RegisteredPlugins() => Inner.RegisteredPlugins();
    public virtual void SetCommittedBaseline(PluginCopyKey key, IReadOnlyList<(string FormKey, string Body)> baselines) =>
        Inner.SetCommittedBaseline(key, baselines);
    public virtual void MarkWorkingTreeOnly(PluginCopyKey key, IReadOnlyList<string> formKeys) =>
        Inner.MarkWorkingTreeOnly(key, formKeys);
    public virtual void SeedCommittedOnly(PluginCopyKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records) =>
        Inner.SeedCommittedOnly(key, records);
    public virtual void Dispose() => Inner.Dispose();

    public virtual IRecordReads At(RecordRef recordRef) => Inner.At(recordRef);
}
