using MEditService.LoadOrder;
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
        var applied = new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, []);

        holder.Apply(applied);

        Assert.Same(applied, holder.Require());
    }

    [Fact]
    public void Require_AfterApplyingTheEmptyValue_RefusesAgain()
    {
        var holder = new LoadOrderHolder();
        // Closing the load order applies Empty; a read after it must refuse exactly as it did
        // before the first snapshot.
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, []));

        holder.Apply(LoadOrderSnapshot.Empty);

        Assert.Throws<NoLoadOrderException>(() => holder.Require());
    }

    // The Index and the watcher each subscribe at composition rather than being called by name
    // from a write endpoint — Apply is the one signal both react to.
    [Fact]
    public void Apply_RaisesChanged_WithTheAppliedSnapshot()
    {
        var holder = new LoadOrderHolder();
        var applied = new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, []);
        LoadOrderSnapshot? seen = null;
        holder.Changed += (snapshot, _) => seen = snapshot;

        holder.Apply(applied);

        Assert.Same(applied, seen);
    }

    // A client waits for the Index's status to reach the version this call answers with — Changed
    // must carry the same number Apply itself returns, not a separately counted one.
    [Fact]
    public void Apply_ReturnsAMonotonicVersion_MatchingWhatChangedCarries()
    {
        var holder = new LoadOrderHolder();
        var seen = new List<long>();
        holder.Changed += (_, version) => seen.Add(version);

        var first = holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, []));
        var second = holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [Registered("A.esp", 0)]));

        Assert.True(second > first);
        Assert.Equal([first, second], seen);
    }

    // The rival: a single subscriber field (rather than a multicast event) would let a second
    // subscription silently replace the first instead of adding to it.
    [Fact]
    public void Apply_RaisesChanged_OnEverySubscriber()
    {
        var holder = new LoadOrderHolder();
        var applied = new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, []);
        var firstSeen = false;
        var secondSeen = false;
        holder.Changed += (_, _) => firstSeen = true;
        holder.Changed += (_, _) => secondSeen = true;

        holder.Apply(applied);

        Assert.True(firstSeen);
        Assert.True(secondSeen);
    }

    // ADR-0013 invariant 1: an identical snapshot is a no-op at the door. Changed is what re-arms the
    // watcher and reconciles the Index, so neither runs.
    [Fact]
    public void Apply_ASnapshotEqualToTheCurrentOne_RaisesNoChanged_AndAnswersTheCurrentVersion()
    {
        var holder = new LoadOrderHolder();
        var applied = holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, [Registered("A.esp", 0)]));
        var changes = 0;
        holder.Changed += (_, _) => changes++;

        var again = holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, [Registered("A.esp", 0)]));

        Assert.Equal(0, changes);
        Assert.Equal(applied, again);
        Assert.Equal(applied, holder.Version);
    }

    [Fact]
    public void Apply_ASnapshotThatMovedAPlugin_RaisesChanged()
    {
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [Registered("A.esp", 0), Registered("B.esp", 1)]));
        var changes = 0;
        holder.Changed += (_, _) => changes++;

        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [Registered("A.esp", 1), Registered("B.esp", 0)]));

        Assert.Equal(1, changes);
    }

    [Fact]
    public void Held_IsNothingBeforeAnArrival_ThenTheSnapshotWithTheVersionItArrivedAs()
    {
        var holder = new LoadOrderHolder();
        Assert.Null(holder.Held);
        var applied = new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [Registered("A.esp", 0)]);

        var version = holder.Apply(applied);

        Assert.Equal((applied, version), holder.Held);
    }

    private static RegisteredPlugin Registered(string name, int slot) =>
        new(name, "ModA", $@"C:\MO2\Fallout4\mods\ModA\{name}", slot, Enabled: true, Winning: true);

    // A subscriber with nothing registered is Apply's ordinary case (every test elsewhere in this
    // file), so raising Changed must never require one.
    [Fact]
    public void Apply_WithNoSubscribers_DoesNotThrow()
    {
        var holder = new LoadOrderHolder();

        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, []));
    }
}
