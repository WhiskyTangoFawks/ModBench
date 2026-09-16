using MEditService.Index;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Plugins;

/// <summary>ADR-0015 invariant 4's second trigger: a reconcile request, over one plugin or every
/// registered one. The tree is edited by hand with no signal sent, so the index disagrees with its
/// system of record.</summary>
public sealed class ReconcileRequestTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IRecordReads Reads => _mod.Index.RequireReads();

    private void EditTheTreeWithoutASignal()
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));
    }

    [Fact]
    public void ReconcilingOnePlugin_CorrectsARowTheStoreHoldsStale()
    {
        var formKey = _mod.Npc.ToString();
        EditTheTreeWithoutASignal();
        Assert.Equal(IndexedModFixture.NpcEditorId, Reads.GetDocument(formKey, _mod.Plugin)?.EditorId);
        var before = _mod.Index.Sequence;

        var reports = _mod.Index.ValidateIndex(_mod.Plugin);

        var document = Reads.GetDocument(formKey, _mod.Plugin);
        Assert.NotNull(document);
        Assert.Equal("RenamedByHand", document.EditorId);
        Assert.Contains(formKey, Assert.Single(reports).ChangedKeys, StringComparer.Ordinal);
        Assert.True(_mod.Index.Sequence > before);
    }

    [Fact]
    public void ReconcilingEveryPlugin_CoversEveryRegisteredCopy()
    {
        var reports = _mod.Index.ValidateIndex(plugin: null);

        Assert.Equal(
            Reads.OpenedCopies.Keys.OrderBy(k => k.Name, StringComparer.Ordinal).Select(k => k.Name),
            reports.Select(r => r.Plugin.Name).OrderBy(n => n, StringComparer.Ordinal));
    }
}
