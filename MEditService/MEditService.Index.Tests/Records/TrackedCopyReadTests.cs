using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

// Tracked-ness is a read: a copy whose rows were derived from its source tree is tracked, a copy
// derived from its bytes is not, and the answer is scoped by registration like every row.
public sealed class TrackedCopyReadTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("tracked-read")
        .WithPlugin("Tracked.esp", mod => mod.Npcs.AddNew("FromTracked"), origin: "TrackedMod")
        .WithPlugin("Plain.esp", mod => mod.Npcs.AddNew("FromPlain"), origin: "PlainMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly Indexer _index;

    public TrackedCopyReadTests()
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
    public void ACopyIngestedFromItsSourceTree_ReadsAsTracked()
    {
        Assert.Contains(Tracked, _index.RequireReads().GetTrackedCopies());
    }

    [Fact]
    public void ACopyIngestedFromItsBytes_ReadsAsUntracked()
    {
        Assert.DoesNotContain(Plain, _index.RequireReads().GetTrackedCopies());
    }

    // The rival this pins: a set keyed by the default equality, which would lose a copy whose
    // name differs in case from the key a caller asks with.
    [Fact]
    public void TheTrackedSet_ComparesKeysAsEveryOtherLookupDoes()
    {
        Assert.Contains(new PluginAddress("TRACKED.ESP", "trackedmod"), _index.RequireReads().GetTrackedCopies());
    }

    [Fact]
    public void ATrackedCopyTheSnapshotStoppedNaming_IsAbsent()
    {
        _index.Reconcile(_holder, _fixture.GameDirectory, [.. _fixture.Plugins.Where(p => p.Name != Tracked.Name)], GameRelease.Fallout4);

        Assert.DoesNotContain(Tracked, _index.RequireReads().GetTrackedCopies());
    }
}
