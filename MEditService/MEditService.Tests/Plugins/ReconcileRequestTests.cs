using MEditService.Core.Plugins;
using MEditService.Core.Records;
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

    private void CorruptTheStoredBody(string formKey) =>
        DuckDbSql.ExecuteFor(
            ((DuckDbRecordIndex)_mod.Index.Store!).Connection,
            "UPDATE mirror.records SET body = '{\"EditorID\": \"CorruptedInTheStore\"}' WHERE form_key = $1",
            formKey);

    [Fact]
    public void ReconcilingOnePlugin_CorrectsARowCorruptedInTheStore()
    {
        var formKey = _mod.Npc.ToString();
        CorruptTheStoredBody(formKey);
        var before = _mod.Index.Store!.Sequence;

        var reports = _mod.Index.ValidateIndex(_mod.Plugin);

        Assert.Equal(
            IndexedModFixture.NpcEditorId,
            _mod.Index.Store!.At(RecordRef.Effective).GetDocument(formKey, _mod.Plugin)!.EditorId);
        Assert.Contains(formKey, Assert.Single(reports).ChangedKeys, StringComparer.Ordinal);
        Assert.True(_mod.Index.Store!.Sequence > before);
    }

    [Fact]
    public void ReconcilingEveryPlugin_CoversEveryRegisteredCopy()
    {
        var reports = _mod.Index.ValidateIndex(plugin: null);

        Assert.Equal(
            _mod.Index.Store!.RegisteredPlugins().OrderBy(k => k.Name, StringComparer.Ordinal).Select(k => k.Name),
            reports.Select(r => r.Plugin.Name).OrderBy(n => n, StringComparer.Ordinal));
    }
}
