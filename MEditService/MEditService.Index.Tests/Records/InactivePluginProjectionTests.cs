using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0009 invariant 1: a file changing and the active plugins changing are two events. A
/// tracked plugin the game does not load answers no read, and its rows still follow its file.</summary>
public sealed class InactivePluginProjectionTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly LoadOrderHolder _holder = new();
    private readonly Indexer _index;
    private readonly string _npc;

    public InactivePluginProjectionTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("inactive-projection")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single();
        _npc = npc.ToString();
        _index = Indexes.Open(_holder);
        Reconcile(active: true);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IRecordReads Reads => _index.RequireReads();

    private void Reconcile(bool active) =>
        _index.Reconcile(_holder, _fixture.GameDirectory, [_mod with { Enabled = active }], GameRelease.Fallout4);

    [Fact]
    public void AHandEditWhileNotActive_IsTheRecordTheReadsSeeOnceActive()
    {
        var document = Reads.DocumentOf(_npc, _mod.KeyOf());
        Reconcile(active: false);

        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.ValidateIndex(_mod.KeyOf());
        Reconcile(active: true);

        Assert.Equal("RenamedByHand", Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId);
    }

    [Fact]
    public void AHandEditWhileNotActive_IsProjectedOnce()
    {
        var document = Reads.DocumentOf(_npc, _mod.KeyOf());
        Reconcile(active: false);
        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.ValidateIndex(_mod.KeyOf());
        var projected = _index.Sequence;

        _index.ValidateIndex(_mod.KeyOf());

        Assert.Equal(projected, _index.Sequence);
    }

    // A plugin's facts are its row's in Plugins, and a disabled plugin is a row (plugins.md, A row).
    [Fact]
    public void ATrackedPluginThatIsNotActive_IsStillReadAsTracked()
    {
        Reconcile(active: false);

        Assert.Contains(_mod.KeyOf(), Reads.GetTrackedPlugins());
    }

    [Fact]
    public void ASnapshotThatMovesNothing_ProjectsNothingForATrackedPluginThatIsNotActive()
    {
        Reconcile(active: false);
        var settled = _index.Sequence;

        Reconcile(active: false);

        Assert.Equal(settled, _index.Sequence);
    }
}
