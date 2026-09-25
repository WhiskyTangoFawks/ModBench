using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

/// <summary>Which truth a plugin's rows came from changes under the Index (ADR-0007 invariant 3), so
/// tracked-ness moves with it: an indexed plugin gains a repository, a tracked plugin loses one
/// (ADR-0003).</summary>
public sealed class TrackedPluginDerivationTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly Indexer _index;
    private readonly LoadOrderEntry _mod;
    private readonly string _npc;

    public TrackedPluginDerivationTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("tracked-plugin-derivation")
            .WithPlugin(PluginName, mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: Origin)
            .BuildScattered();
        _mod = _fixture.Plugins.Single();
        _npc = npc.ToString();
        _index = Indexes.Open(_holder);
        Reconcile();
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Reconcile() =>
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);

    private bool ReadsAsTracked() => _index.RequireReads().GetTrackedPlugins().Contains(_mod.KeyOf());

    // Track's documents carry the bytes the binary already gave, so the settled Source batch below
    // moves no row: what it moves is which truth answers for the plugin.
    [Fact]
    public void APluginTrackedAfterItWasIndexed_ReadsAsTracked_OnceASourceRefreshLands()
    {
        Assert.False(ReadsAsTracked());
        TrackedMods.Track(_mod, _fixture.GameDirectory);

        _index.RefreshKeys(_mod.KeyOf(), [_npc]);

        Assert.True(ReadsAsTracked());
    }

    [Fact]
    public void APluginTrackedAfterItWasIndexed_ReadsAsTracked_AfterTheNextValidate()
    {
        TrackedMods.Track(_mod, _fixture.GameDirectory);

        _index.ValidateIndex(_mod.KeyOf());

        Assert.True(ReadsAsTracked());
    }

    // The snapshot is the one it already holds: nothing in the load order moved, only which truth
    // the plugin's folder offers.
    [Fact]
    public void APluginTrackedAfterItWasIndexed_ReadsAsTracked_AfterTheNextSnapshot()
    {
        TrackedMods.Track(_mod, _fixture.GameDirectory);

        Reconcile();

        Assert.True(ReadsAsTracked());
    }

    [Fact]
    public void ATrackedPluginWhoseRepositoryWentAway_ReadsAsUntracked_AfterTheNextSnapshot()
    {
        TrackedMods.Track(_mod, _fixture.GameDirectory);
        _index.ValidateIndex(_mod.KeyOf());
        Assert.True(ReadsAsTracked());

        Directory.Delete(Path.Combine(_mod.ModFolderOf(), ".git"), recursive: true);
        Reconcile();

        Assert.False(ReadsAsTracked());
    }

    [Fact]
    public void ATrackedPluginWhoseRepositoryWentAway_ReadsAsUntracked_AfterTheNextValidate()
    {
        TrackedMods.Track(_mod, _fixture.GameDirectory);
        _index.ValidateIndex(_mod.KeyOf());
        Assert.True(ReadsAsTracked());

        Directory.Delete(Path.Combine(_mod.ModFolderOf(), ".git"), recursive: true);
        _index.ValidateIndex(_mod.KeyOf());

        Assert.False(ReadsAsTracked());
    }
}
