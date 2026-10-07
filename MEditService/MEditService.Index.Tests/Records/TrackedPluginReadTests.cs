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

    [Fact]
    public void APluginIngestedFromItsSourceTree_ReadsAsDerivedFromIt()
    {
        Assert.Equal(DerivedFrom.SourceTree, _index.RequireReads().DerivationOf(Tracked));
    }

    [Fact]
    public void APluginIngestedFromItsBytes_ReadsAsDerivedFromThem()
    {
        Assert.Equal(DerivedFrom.Binary, _index.RequireReads().DerivationOf(Plain));
    }

    [Fact]
    public void TheDerivations_FindAPluginWhoseNameAndOriginDifferInCaseFromTheAskedKey()
    {
        Assert.Equal(DerivedFrom.SourceTree, _index.RequireReads().DerivationOf(new PluginAddress("TRACKED.ESP", "trackedmod")));
    }

    [Fact]
    public void ATrackedPluginTheSnapshotStoppedNaming_IsAbsent()
    {
        _index.Reconcile(_holder, _fixture.GameDirectory, [.. _fixture.Plugins.Where(p => p.Name != Tracked.Name)], GameRelease.Fallout4);

        Assert.Null(_index.RequireReads().DerivationOf(Tracked));
    }
}
