using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

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
        var applied = SnapshotActivatingInTheOrderGiven(@"C:\MO2\Fallout4");

        holder.Apply(applied);

        Assert.Same(applied, holder.Require());
    }

    [Fact]
    public void Require_AfterApplyingTheEmptyValue_RefusesAgain()
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotActivatingInTheOrderGiven(null));

        holder.Apply(EmptyLoadOrder.Of(default));

        Assert.Throws<NoLoadOrderException>(() => holder.Require());
    }

    [Fact]
    public void Apply_RaisesArrived_WithTheAppliedSnapshot()
    {
        var holder = new LoadOrderHolder();
        var applied = SnapshotActivatingInTheOrderGiven(@"C:\MO2\Fallout4");
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

        var first = holder.Apply(SnapshotActivatingInTheOrderGiven(null));
        var second = holder.Apply(SnapshotActivatingInTheOrderGiven(null, "A.esp"));

        Assert.True(second > first);
        Assert.Equal([first, second], seen);
    }

    [Fact]
    public void Apply_ASnapshotEqualToTheCurrentOne_Arrives_WithTheCurrentVersion_AndKeepsTheValueHeld()
    {
        var holder = new LoadOrderHolder();
        var applied = holder.Apply(SnapshotActivatingInTheOrderGiven(@"C:\MO2\Fallout4", "A.esp"));
        var held = holder.Current;
        var arrivals = new List<long>();
        holder.Arrived += (_, version) => arrivals.Add(version);

        var again = holder.Apply(SnapshotActivatingInTheOrderGiven(@"C:\MO2\Fallout4", "A.esp"));

        Assert.Equal([applied], arrivals);
        Assert.Equal(applied, again);
        Assert.Equal(applied, holder.Held?.Version);
        Assert.Same(held, holder.Current);
    }

    [Fact]
    public void Apply_ASnapshotThatMovedOnlyTheActivePlugins_IsHeld_AsTheNextVersion()
    {
        var holder = new LoadOrderHolder();
        var first = holder.Apply(SnapshotActivatingInTheOrderGiven(null, "A.esp", "B.esp"));
        var moved = SnapshotActivatingInTheOrderGiven(null, "B.esp", "A.esp");

        var second = holder.Apply(moved);

        Assert.Equal(first + 1, second);
        Assert.Same(moved, holder.Require());
    }

    [Fact]
    public void Apply_ASnapshotThatMovedOnlyADisabledLine_IsHeld()
    {
        var holder = new LoadOrderHolder();
        var active = Registered("A.esp") with { Line = new PluginLine(0, NamesIt: true) };
        LoadOrderSnapshot DisabledLineAt(int line) => new(
            @"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, [active, Registered("B.esp") with { Line = new PluginLine(line, NamesIt: true) }], [active.Key], [], [], [], [], Language.English);
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

    private static RegisteredPlugin Registered(string name) => new(name, "ModA", $@"C:\MO2\Fallout4\mods\ModA\{name}", new PluginProvider.FromMod("ModA", @"C:\MO2\Fallout4\mods\ModA", @"C:\MO2\Fallout4\source\ModA"), Line: null, PluginStrings.None);

    private static LoadOrderSnapshot SnapshotActivatingInTheOrderGiven(string? instanceRoot, params string[] active) =>
        new(@"C:\Games\Fallout4\Data", instanceRoot, GameRelease.Fallout4,
            [.. active.Order(StringComparer.Ordinal).Select(Registered)], [.. active.Select(name => Registered(name).Key)], [], [], [], [], Language.English);
}
