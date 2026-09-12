using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// ADR-0013's participation and winner rules, on the immutable value the shared kernel holds. No
// DuckDB and no disk: a snapshot goes in, participation and winners come out.
public sealed class LoadOrderTests
{
    private const string Data = @"C:\Games\Fallout4\Data";
    private const string Instance = @"C:\MO2\Fallout4";

    private static RegisteredCopy Copy(
        string name, string origin, int? slot, bool enabled = true, bool winning = true) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), slot, enabled, winning);

    private static LoadOrderSnapshot Order(params RegisteredCopy[] copies) =>
        new(Data, Instance, GameRelease.Fallout4, copies);

    [Fact]
    public void DisabledCopy_DoesNotParticipate_AndIsStillRegistered()
    {
        var order = Order(Copy("A.esp", "ModA", slot: 0, enabled: false));

        Assert.False(order.Participates(new PluginKey("A.esp", "ModA")));
        Assert.Empty(order.Participating);
        Assert.Equal(new Registration(0, Enabled: false, Winning: true), order.Registration(new PluginKey("A.esp", "ModA")));
    }

    [Fact]
    public void CopyThatLostTheOverrideOrder_DoesNotParticipate_AndWinningCopyNamesTheOther()
    {
        var winner = Copy("A.esp", "HighPriorityMod", slot: 0);
        var loser = Copy("A.esp", "LowPriorityMod", slot: 0, winning: false);
        // The loser first, so snapshot order cannot stand in for the override order.
        var order = Order(loser, winner);

        Assert.False(order.Participates(loser.Key));
        Assert.True(order.Participates(winner.Key));
        Assert.Equal(winner, order.WinningCopy("A.esp"));
        Assert.Equal([winner], order.Participating);
    }

    [Fact]
    public void CopyWithNoPluginsTxtLine_DoesNotParticipate()
    {
        var unlisted = Copy("Unlisted.esp", "ModU", slot: null);
        var order = Order(unlisted, Copy("Listed.esp", "ModL", slot: 0));

        Assert.False(order.Participates(unlisted.Key));
        Assert.Equal(unlisted, order.WinningCopy("Unlisted.esp"));
        Assert.Equal(["Listed.esp"], order.Participating.Select(c => c.Name));
    }

    [Fact]
    public void Participating_IsInSlotOrder_NotSnapshotOrder()
    {
        var third = Copy("C.esp", "ModC", slot: 2);
        var first = Copy("A.esp", "ModA", slot: 0);
        var second = Copy("B.esp", "ModB", slot: 1);

        Assert.Equal([first, second, third], Order(third, first, second).Participating);
    }

    [Fact]
    public void EmptySnapshot_YieldsNoParticipants_AndKnowsNoCopy()
    {
        var order = Order();

        Assert.Empty(order.Participating);
        Assert.Null(order.WinningCopy("A.esp"));
        Assert.Null(order.Registration(new PluginKey("A.esp", "ModA")));
        Assert.False(order.Participates(new PluginKey("A.esp", "ModA")));
    }

    [Fact]
    public void ApplyingTheSameSnapshotTwice_YieldsAnEqualValue()
    {
        var holder = new LoadOrderHolder();
        var copies = () => new[] { Copy("A.esp", "ModA", slot: 0), Copy("B.esp", "ModB", slot: 1, winning: false) };

        holder.Apply(Order(copies()));
        var first = holder.Current;
        holder.Apply(Order(copies()));

        Assert.Equal(first, holder.Current);
        Assert.NotSame(first, holder.Current);
    }

    [Fact]
    public void ApplyingADifferentSnapshot_ReplacesTheValue()
    {
        var holder = new LoadOrderHolder();
        Assert.Equal(LoadOrderSnapshot.Empty, holder.Current);

        holder.Apply(Order(Copy("A.esp", "ModA", slot: 0)));
        Assert.Equal(["A.esp"], holder.Current.Participating.Select(c => c.Name));

        holder.Apply(Order(Copy("A.esp", "ModA", slot: 0, enabled: false)));
        Assert.Empty(holder.Current.Participating);
    }

    [Fact]
    public void EqualValues_HashAlike_WhenTheirPathsDifferOnlyInCase()
    {
        var copy = Copy("A.esp", "ModA", slot: 0);
        var lower = new LoadOrderSnapshot(Data.ToLowerInvariant(), Instance.ToLowerInvariant(), GameRelease.Fallout4, [copy]);

        Assert.Equal(Order(copy), lower);
        Assert.Equal(Order(copy).GetHashCode(), lower.GetHashCode());
    }

    [Fact]
    public void TheCallersList_IsCopiedOnConstruction_SoTheValueCannotChangeBehindIt()
    {
        var copies = new List<RegisteredCopy> { Copy("A.esp", "ModA", slot: 0) };
        var order = new LoadOrderSnapshot(Data, Instance, GameRelease.Fallout4, copies);

        copies.Add(Copy("B.esp", "ModB", slot: 1));

        Assert.Equal(["A.esp"], order.Copies.Select(c => c.Name));
    }

    // ADR-0007: created before any plugins.txt line names it, so the gesture that follows sees it.
    [Fact]
    public void With_AddsACreatedCopy_AndReplacesTheOneAlreadyUnderThatIdentity()
    {
        var added = Order(Copy("A.esp", "ModA", slot: 0)).With(Copy("New.esp", "ModA", slot: 1));
        Assert.Equal(["A.esp", "New.esp"], added.Copies.Select(c => c.Name));

        var replaced = added.With(Copy("New.esp", "ModA", slot: 1, enabled: false));
        Assert.Equal(["A.esp", "New.esp"], replaced.Copies.Select(c => c.Name));
        Assert.False(replaced.Participates(new PluginKey("New.esp", "ModA")));
    }

    // ADR-0007's counterpart: a create that could not write its file takes its registration back,
    // and only that one — two copies of one filename are two identities (ADR-0012).
    [Fact]
    public void Without_RemovesOnlyTheCopyUnderThatIdentity()
    {
        var order = Order(Copy("A.esp", "ModA", slot: 0), Copy("A.esp", "ModB", slot: 1));

        var left = order.Without(new PluginKey("A.esp", "ModB"));

        Assert.Equal(["ModA"], left.Copies.Select(c => c.Origin));
        Assert.Equal(order.Copies, order.Without(new PluginKey("Absent.esp", "ModA")).Copies);
    }

    // The entries are the whole of the snapshot: the path they carry names no directory that
    // exists, and the value resolves participation and the winner without one.
    [Fact]
    public void AValueBuiltFromEntriesAlone_WithNoDirectoryPresent_ParticipatesAndWins()
    {
        var absent = Path.Combine(Path.GetTempPath(), $"medit-no-such-data-{Guid.NewGuid():N}");
        LoadOrderEntry Entry(string origin, bool winning) =>
            new("A.esp", Path.Combine(absent, origin, "A.esp"), origin, Slot: 0, Enabled: true, winning);
        LoadOrderEntry[] entries = [Entry("LowPriorityMod", winning: false), Entry("HighPriorityMod", winning: true)];

        var order = new LoadOrderSnapshot(
            absent, null, GameRelease.Fallout4, [.. entries.Select(entry => RegisteredCopy.Of(entry))]);

        Assert.False(Directory.Exists(absent));
        Assert.Equal("HighPriorityMod", order.WinningCopy("A.esp")!.Origin);
        Assert.Equal([new PluginKey("A.esp", "HighPriorityMod")], order.Participating.Select(c => c.Key));
        Assert.False(order.Participates(new PluginKey("A.esp", "LowPriorityMod")));
    }

    [Fact]
    public void ACopyIsIdentifiedByOriginAndName_NotByNameAlone()
    {
        var order = Order(Copy("A.esp", "ModA", slot: 0), Copy("A.esp", "ModB", slot: 0, winning: false));

        Assert.Equal("ModA", order.Copy(new PluginKey("A.esp", "ModA"))!.Origin);
        Assert.Equal("ModB", order.Copy(new PluginKey("A.esp", "ModB"))!.Origin);
        Assert.Null(order.Copy(new PluginKey("A.esp", "ModC")));
    }
}
