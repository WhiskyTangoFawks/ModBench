using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

// ADR-0013: the handler that turns a validated snapshot into Load order state's one arrival —
// what a reconcile does with that arrival is the Index's subscription, not this handler's.
public sealed class PutLoadOrderHandlerTests
{
    private readonly LoadOrderHolder _holder = new();
    private PutLoadOrderHandler Handler => TestEditService.PutLoadOrderHandler(_holder);

    private static LoadOrderSnapshot Snapshot(GameRelease release = GameRelease.Fallout4) =>
        new("C:\\Data", "C:\\Instance", release, [new RegisteredCopy("A.esp", "ModA", "C:\\Instance\\A.esp", 0, true, true)]);

    [Fact]
    public void Put_WithASupportedRelease_AppliesTheSnapshotToLoadOrderState()
    {
        var snapshot = Snapshot();

        var result = Handler.Put(snapshot);

        Assert.True(result.Applied);
        Assert.Same(snapshot, _holder.Current);
    }

    // A release this build has no Mutagen assembly for is discovered here, synchronously, never
    // inside a reconcile the caller cannot see.
    [Fact]
    public void Put_UnsupportedGameRelease_RefusesWithoutApplying()
    {
        var snapshot = Snapshot(GameRelease.SkyrimSE);

        var result = Handler.Put(snapshot);

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.UnsupportedGameRelease, result.Refusal);
        Assert.Contains("SkyrimSE", result.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }
}
