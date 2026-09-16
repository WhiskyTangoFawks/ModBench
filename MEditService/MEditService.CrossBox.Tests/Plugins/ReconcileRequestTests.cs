using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Plugins;

/// <summary>ADR-0015 invariant 4's second trigger: a reconcile request, over one plugin or every
/// registered one. The store is corrupted by hand because nothing else makes the index disagree with
/// an untouched system of record.</summary>
public sealed class ReconcileRequestTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IRecordIndex Store =>
        _mod.Index.Store ?? throw new InvalidOperationException("Expected the index to already hold a built store.");

    private void CorruptTheStoredBody(string formKey) =>
        DuckDbSql.ExecuteFor(
            ((DuckDbRecordIndex)Store).Connection,
            "UPDATE mirror.records SET body = '{\"EditorID\": \"CorruptedInTheStore\"}' WHERE form_key = $1",
            formKey);

    [Fact]
    public void ReconcilingOnePlugin_CorrectsARowCorruptedInTheStore()
    {
        var formKey = _mod.Npc.ToString();
        CorruptTheStoredBody(formKey);
        var before = Store.Sequence;

        var reports = _mod.Index.ValidateIndex(_mod.Plugin);

        var document = Store.At(RecordRef.Effective).GetDocument(formKey, _mod.Plugin);
        Assert.NotNull(document);
        Assert.Equal(IndexedModFixture.NpcEditorId, document.EditorId);
        Assert.Contains(formKey, Assert.Single(reports).ChangedKeys, StringComparer.Ordinal);
        Assert.True(Store.Sequence > before);
    }

    [Fact]
    public void ReconcilingEveryPlugin_CoversEveryRegisteredCopy()
    {
        var reports = _mod.Index.ValidateIndex(plugin: null);

        Assert.Equal(
            Store.RegisteredPlugins().OrderBy(k => k.Name, StringComparer.Ordinal).Select(k => k.Name),
            reports.Select(r => r.Plugin.Name).OrderBy(n => n, StringComparer.Ordinal));
    }
}
