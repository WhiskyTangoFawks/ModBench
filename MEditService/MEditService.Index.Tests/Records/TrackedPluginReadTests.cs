using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

public sealed class TrackedPluginReadTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("tracked-read")
        .WithPlugin("Tracked.esp", mod => mod.Npcs.AddNew("FromTracked"), origin: "TrackedMod")
        .WithPlugin("Plain.esp", mod => mod.Npcs.AddNew("FromPlain"), origin: "PlainMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public TrackedPluginReadTests()
    {
        TrackedMods.Track(_fixture.Plugins.Single(p => p.Name == Tracked.Name), _fixture.GameDirectory);
        _index = Indexes.Open(_holder);
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly PluginAddress Tracked = new("Tracked.esp", "TrackedMod");
    private static readonly PluginAddress Plain = new("Plain.esp", "PlainMod");

    private bool ReadsFromItsTree(PluginAddress plugin) =>
        _index.PluginRowOf(plugin) is { IsTracked: true, PluginSourceUnreadableReason: null };

    [Fact]
    public void APluginIngestedFromItsSourceTree_ReadsAsDerivedFromIt()
    {
        Assert.True(ReadsFromItsTree(Tracked));
    }

    [Fact]
    public void APluginIngestedFromItsBytes_ReadsAsDerivedFromThem()
    {
        Assert.False(_index.PluginRowOf(Plain)?.IsTracked ?? true);
    }

    [Fact]
    public void ALoadOrderNamingATrackedPluginInAnotherCase_StillReadsItAsDerivedFromItsTree()
    {
        var recased = new PluginAddress("TRACKED.ESP", "trackedmod");
        _index.Reconcile(_holder, _fixture.GameDirectory,
            [.. _fixture.Plugins.Select(p => p.Name == Tracked.Name ? p with { Name = recased.Name, Origin = recased.Origin } : p)],
            GameRelease.Fallout4);

        Assert.True(ReadsFromItsTree(recased));
    }

    [Fact]
    public void ATrackedPluginTheSnapshotStoppedNaming_IsAbsent()
    {
        _index.Reconcile(_holder, _fixture.GameDirectory, [.. _fixture.Plugins.Where(p => p.Name != Tracked.Name)], GameRelease.Fallout4);

        Assert.Null(_index.PluginRowOf(Tracked));
    }
}
