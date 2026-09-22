using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Plugins;

/// <summary>ADR-0015 invariant 4's second trigger: a reconcile request, over one plugin or every
/// registered one. The tree is edited by hand with no signal sent, so the index disagrees with its
/// system of record.</summary>
public sealed class ReconcileRequestTests : IDisposable
{
    private const string NpcEditorId = "FixtureNpc";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly string _formKey;

    public ReconcileRequestTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("reconcile-request")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew(NpcEditorId).FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _entry = _fixture.Plugins.Single();
        _formKey = npc.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ReconcilingOnePlugin_CorrectsARowTheStoreHoldsStale()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        _entry.HandEdit(reads.DocumentOf(_formKey, _entry.KeyOf()), NpcEditorId, "RenamedByHand");
        Assert.Equal(NpcEditorId, reads.DocumentOf(_formKey, _entry.KeyOf()).EditorId);
        var before = index.Sequence;

        var reports = index.ValidateIndex(_entry.KeyOf());

        Assert.Equal("RenamedByHand", reads.DocumentOf(_formKey, _entry.KeyOf()).EditorId);
        Assert.Contains(_formKey, Assert.Single(reports).ChangedKeys, StringComparer.Ordinal);
        Assert.True(index.Sequence > before);
    }

    [Fact]
    public void ReconcilingEveryPlugin_CoversEveryRegisteredCopy()
    {
        using var index = Indexes.Reconciled(_fixture);

        var reports = index.ValidateIndex(plugin: null);

        Assert.Equal(
            index.RequireReads().OpenedCopies.Keys.OrderBy(k => k.Name, StringComparer.Ordinal).Select(k => k.Name),
            reports.Select(r => r.Plugin.Name).OrderBy(n => n, StringComparer.Ordinal));
    }
}
