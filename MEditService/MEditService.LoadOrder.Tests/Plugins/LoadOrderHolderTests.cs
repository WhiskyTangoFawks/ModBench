using Mutagen.Bethesda;

namespace MEditService.LoadOrder.Tests.Plugins;

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
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [], [], []));

        holder.Apply(new LoadOrderSnapshot(string.Empty, null, default, [], [], []));

        Assert.Throws<NoLoadOrderException>(() => holder.Require());
    }

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

    [Fact]
    public void Apply_ReturnsAMonotonicVersion_MatchingWhatArrivedCarries()
    {
        var holder = new LoadOrderHolder();
        var seen = new List<long>();
        holder.Arrived += (_, version) => seen.Add(version);

        var first = holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [], [], []));
        var second = holder.Apply(SnapshotActivatingInTheOrderGiven(null, "A.esp"));

        Assert.True(second > first);
        Assert.Equal([first, second], seen);
    }

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

    [Fact]
    public void Apply_ASnapshotEqualToTheCurrentOne_Arrives_WithTheCurrentVersion()
    {
        var holder = new LoadOrderHolder();
        var applied = holder.Apply(SnapshotActivatingInTheOrderGiven(@"C:\MO2\Fallout4", "A.esp"));
        var arrivals = new List<long>();
        holder.Arrived += (_, version) => arrivals.Add(version);

        var again = holder.Apply(SnapshotActivatingInTheOrderGiven(@"C:\MO2\Fallout4", "A.esp"));

        Assert.Equal([applied], arrivals);
        Assert.Equal(applied, again);
        Assert.Equal(applied, holder.Held?.Version);
    }

    [Fact]
    public void Apply_ASnapshotThatMovedAPlugin_Arrives()
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotActivatingInTheOrderGiven(null, "A.esp", "B.esp"));
        var changes = 0;
        holder.Arrived += (_, _) => changes++;

        holder.Apply(SnapshotActivatingInTheOrderGiven(null, "B.esp", "A.esp"));

        Assert.Equal(1, changes);
    }

    [Fact]
    public void Apply_ASnapshotThatMovedOnlyADisabledLine_IsHeld()
    {
        var holder = new LoadOrderHolder();
        var active = Registered("A.esp") with { Line = 0 };
        LoadOrderSnapshot DisabledLineAt(int line) => new(
            @"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [active, Registered("B.esp") with { Line = line }], [active.Key], []);
        holder.Apply(DisabledLineAt(1));
        var moved = DisabledLineAt(2);

        holder.Apply(moved);

        Assert.Same(moved, holder.Require());
    }

    [Fact]
    public void Held_IsNothingBeforeAnArrival_ThenTheSnapshotWithTheVersionItArrivedAs()
    {
        var holder = new LoadOrderHolder();
        Assert.Null(holder.Held);
        var applied = SnapshotActivatingInTheOrderGiven(null, "A.esp");

        var version = holder.Apply(applied);

        Assert.Equal((applied, version), holder.Held);
    }

    private static RegisteredPlugin Registered(string name) => new(name, "ModA", $@"C:\MO2\Fallout4\mods\ModA\{name}", new PluginProvider.FromMod("ModA", @"C:\MO2\Fallout4\mods\ModA"), Line: null);

    private static LoadOrderSnapshot SnapshotActivatingInTheOrderGiven(string? instanceRoot, params string[] active) =>
        new(@"C:\Games\Fallout4\Data", instanceRoot, GameRelease.Fallout4,
            [.. active.Order(StringComparer.Ordinal).Select(Registered)], [.. active.Select(name => Registered(name).Key)], []);

    [Fact]
    public void Apply_WithNoSubscribers_DoesNotThrow()
    {
        var holder = new LoadOrderHolder();

        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, [], [], []));
    }
}
