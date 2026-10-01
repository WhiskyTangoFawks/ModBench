using Mutagen.Bethesda;

namespace MEditService.LoadOrder.Tests.Plugins;

// The one place a read refuses for want of a load order: every query service asks the holder for
// the value it must have, and the refusal is this exception with this message.
public sealed class LoadOrderHolderTests
{
    [Fact]
    public void Require_NothingApplied_RefusesWithNoLoadOrder()
    {
        var holder = new LoadOrderHolder();

        Assert.Throws<NoLoadOrderException>(() => holder.Require());
    }

    [Fact]
    public void Require_AfterApply_ReturnsTheAppliedValue()
    {
        var holder = new LoadOrderHolder();
        var applied = new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, [], [], []);

        holder.Apply(applied);

        Assert.Same(applied, holder.Require());
    }

    [Fact]
    public void Require_AfterApplyingTheEmptyValue_RefusesAgain()
    {
        var holder = new LoadOrderHolder();
        // Closing the load order applies Empty; a read after it must refuse exactly as it did
        // before the first snapshot.
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [], [], []));

        holder.Apply(LoadOrderSnapshot.Empty);

        Assert.Throws<NoLoadOrderException>(() => holder.Require());
    }

    // The Index subscribes at composition rather than being called by name from a write endpoint.
    [Fact]
    public void Apply_RaisesArrived_WithTheAppliedSnapshot()
    {
        var holder = new LoadOrderHolder();
        var applied = new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, [], [], []);
        LoadOrderSnapshot? seen = null;
        holder.Arrived += (snapshot, _) => seen = snapshot;

        holder.Apply(applied);

        Assert.Same(applied, seen);
    }

    // A client waits for the Index's status to reach the version this call answers with — Arrived
    // must carry the same number Apply itself returns, not a separately counted one.
    [Fact]
    public void Apply_ReturnsAMonotonicVersion_MatchingWhatArrivedCarries()
    {
        var holder = new LoadOrderHolder();
        var seen = new List<long>();
        holder.Arrived += (_, version) => seen.Add(version);

        var first = holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [], [], []));
        var second = holder.Apply(Snapshot(null, "A.esp"));

        Assert.True(second > first);
        Assert.Equal([first, second], seen);
    }

    // The rival: a single subscriber field (rather than a multicast event) would let a second
    // subscription silently replace the first instead of adding to it.
    [Fact]
    public void Apply_RaisesArrived_OnEverySubscriber()
    {
        var holder = new LoadOrderHolder();
        var applied = new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, [], [], []);
        var firstSeen = false;
        var secondSeen = false;
        holder.Arrived += (_, _) => firstSeen = true;
        holder.Arrived += (_, _) => secondSeen = true;

        holder.Apply(applied);

        Assert.True(firstSeen);
        Assert.True(secondSeen);
    }

    // ADR-0013 invariant 1: every recompute sends the snapshot, changed or not, because the snapshot
    // is also the signal that a file may have changed. The version moves only with the load order.
    [Fact]
    public void Apply_ASnapshotEqualToTheCurrentOne_Arrives_WithTheCurrentVersion()
    {
        var holder = new LoadOrderHolder();
        var applied = holder.Apply(Snapshot(@"C:\MO2\Fallout4", "A.esp"));
        var arrivals = new List<long>();
        holder.Arrived += (_, version) => arrivals.Add(version);

        var again = holder.Apply(Snapshot(@"C:\MO2\Fallout4", "A.esp"));

        Assert.Equal([applied], arrivals);
        Assert.Equal(applied, again);
        Assert.Equal(applied, holder.Version);
    }

    [Fact]
    public void Apply_ASnapshotThatMovedAPlugin_Arrives()
    {
        var holder = new LoadOrderHolder();
        holder.Apply(Snapshot(null, "A.esp", "B.esp"));
        var changes = 0;
        holder.Arrived += (_, _) => changes++;

        holder.Apply(Snapshot(null, "B.esp", "A.esp"));

        Assert.Equal(1, changes);
    }

    [Fact]
    public void Held_IsNothingBeforeAnArrival_ThenTheSnapshotWithTheVersionItArrivedAs()
    {
        var holder = new LoadOrderHolder();
        Assert.Null(holder.Held);
        var applied = Snapshot(null, "A.esp");

        var version = holder.Apply(applied);

        Assert.Equal((applied, version), holder.Held);
    }

    private static RegisteredPlugin Registered(string name) => new(name, "ModA", $@"C:\MO2\Fallout4\mods\ModA\{name}");

    // Every plugin named is active, in the order named; the plugins themselves sort by name, so a
    // snapshot that moves them changes the active plugins alone.
    private static LoadOrderSnapshot Snapshot(string? instanceRoot, params string[] active) =>
        new(@"C:\Games\Fallout4\Data", instanceRoot, GameRelease.Fallout4,
            [.. active.Order(StringComparer.Ordinal).Select(Registered)], [.. active.Select(name => Registered(name).Key)], []);

    // A subscriber with nothing registered is Apply's ordinary case (every test elsewhere in this
    // file), so raising Arrived must never require one.
    [Fact]
    public void Apply_WithNoSubscribers_DoesNotThrow()
    {
        var holder = new LoadOrderHolder();

        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, [], [], []));
    }
}
