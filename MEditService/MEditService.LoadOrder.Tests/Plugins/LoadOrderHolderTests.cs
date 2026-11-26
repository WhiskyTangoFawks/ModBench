using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.LoadOrder.Tests.Plugins;

public sealed class LoadOrderHolderTests
{
    [Fact]
    public void Require_RefusesUntilASnapshotArrives_AndAgainAfterTheEmptyValue()
    {
        var holder = new LoadOrderHolder();
        Assert.Throws<NoLoadOrderException>(() => holder.Require());
        holder.Apply(SnapshotActivatingInTheOrderGiven(null));

        holder.Apply(EmptyLoadOrder.Of(default));

        Assert.Throws<NoLoadOrderException>(() => holder.Require());
    }

    [Fact]
    public void Apply_OfAChangedSnapshot_HoldsItAsTheNextVersion_AndArrivedCarriesBoth()
    {
        var holder = new LoadOrderHolder();
        Assert.Null(holder.Held);
        var seen = new List<(LoadOrderSnapshot, long)>();
        holder.Arrived += (snapshot, version) => seen.Add((snapshot, version));
        var first = SnapshotActivatingInTheOrderGiven(null, "A.esp", "B.esp");
        var moved = SnapshotActivatingInTheOrderGiven(null, "B.esp", "A.esp");

        var firstVersion = holder.Apply(first);
        var movedVersion = holder.Apply(moved);

        Assert.Equal(firstVersion + 1, movedVersion);
        Assert.Equal([(first, firstVersion), (moved, movedVersion)], seen);
        Assert.Equal((moved, movedVersion), holder.Held);
        Assert.Same(moved, holder.Require());
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

    private static RegisteredPlugin Registered(string name) => new(name, "ModA", $@"C:\MO2\Fallout4\mods\ModA\{name}", new PluginProvider.FromMod("ModA", @"C:\MO2\Fallout4\mods\ModA", @"C:\MO2\Fallout4\source\ModA"), Line: null, PluginStrings.None);

    private static LoadOrderSnapshot SnapshotActivatingInTheOrderGiven(string? instanceRoot, params string[] active) =>
        new(@"C:\Games\Fallout4\Data", instanceRoot, GameRelease.Fallout4,
            [.. active.Order(StringComparer.Ordinal).Select(Registered)], [.. active.Select(name => Registered(name).Key)], [], [], [], [], [], Language.English);
}
