using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class SourcePluginDerivationTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly LoadOrderEntry _mod;
    private readonly string _npc;

    public SourcePluginDerivationTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("sourcePlugin-plugin-derivation")
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

    private bool ReadsAsSourcePlugin() => _index.PluginRowOf(_mod.KeyOf()) is { IsSourcePlugin: true, PluginSourceUnreadable: null };

    [Fact]
    public void APluginSourcePluginAfterItWasIndexed_ReadsAsSourcePlugin_AfterTheNextSnapshot()
    {
        Assert.False(ReadsAsSourcePlugin());
        SourceMods.Track(_mod);

        _index.NextSnapshotUntil(ReadsAsSourcePlugin, "the plugin reading as source plugin");
    }

    [Fact]
    public void ASourcePluginWhoseRepositoryWentAway_ReadsAsNonSourcePlugin_AfterTheNextSnapshot()
    {
        SourceMods.Track(_mod);
        _index.NextSnapshotUntil(ReadsAsSourcePlugin, "the plugin reading as source plugin");

        AnotherTool.Delete(Path.Combine(_mod.ModFolderOf(), ".git"));
        _index.NextSnapshotUntil(() => !ReadsAsSourcePlugin(), "the plugin reading as non-source plugin");
    }
}
