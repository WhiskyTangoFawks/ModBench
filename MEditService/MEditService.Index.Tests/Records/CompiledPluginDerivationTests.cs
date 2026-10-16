using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class CompiledPluginDerivationTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly LoadOrderEntry _mod;
    private readonly string _npc;

    public CompiledPluginDerivationTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("compiled-plugin-derivation")
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

    private bool ReadsAsCompiledPlugin() => _index.PluginRowOf(_mod.KeyOf()) is { IsCompiledPlugin: true, PluginSourceUnreadable: null };

    [Fact]
    public void APluginCompiledPluginAfterItWasIndexed_ReadsAsCompiledPlugin_AfterTheNextSnapshot()
    {
        Assert.False(ReadsAsCompiledPlugin());
        SourceMods.Init(_mod);

        _index.NextSnapshotUntil(ReadsAsCompiledPlugin, "the plugin reading as compiled plugin");
    }

    [Fact]
    public void ACompiledPluginWhoseRepositoryWentAway_ReadsAsNonCompiledPlugin_AfterTheNextSnapshot()
    {
        SourceMods.Init(_mod);
        _index.NextSnapshotUntil(ReadsAsCompiledPlugin, "the plugin reading as compiled plugin");

        AnotherTool.Delete(Path.Combine(_mod.ModFolderOf(), ".git"));
        _index.NextSnapshotUntil(() => !ReadsAsCompiledPlugin(), "the plugin reading as non-compiled plugin");
    }
}
