using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

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
        ReconcileTheSnapshotAlreadyHeldSinceOnlyThePluginsFolderMoved();
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void ReconcileTheSnapshotAlreadyHeldSinceOnlyThePluginsFolderMoved() =>
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);

    private bool ReadsAsTracked() => _index.RequireReads().GetTrackedPlugins().Contains(_mod.KeyOf());

    [Fact]
    public void APluginTrackedAfterItWasIndexed_ReadsAsTracked_AfterTheNextSnapshot()
    {
        Assert.False(ReadsAsTracked());
        TrackedMods.Track(_mod, _fixture.GameDirectory);

        _holder.Apply(_holder.Current);

        Waits.Reached(ReadsAsTracked, "the plugin reading as tracked", TimeSpan.FromSeconds(30));
    }

    [Fact]
    public void ATrackedPluginWhoseRepositoryWentAway_ReadsAsUntracked_AfterTheNextSnapshot()
    {
        TrackedMods.Track(_mod, _fixture.GameDirectory);
        _holder.Apply(_holder.Current);
        Waits.Reached(ReadsAsTracked, "the plugin reading as tracked", TimeSpan.FromSeconds(30));

        Directory.Delete(Path.Combine(_mod.ModFolderOf(), ".git"), recursive: true);
        _holder.Apply(_holder.Current);

        Waits.Reached(() => !ReadsAsTracked(), "the plugin reading as untracked", TimeSpan.FromSeconds(30));
    }
}
