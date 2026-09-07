using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// ADR-0044's participation and winner rules, on the immutable value the shared kernel holds. No
// DuckDB and no disk: a snapshot goes in, participation and winners come out.
public sealed class LoadOrderTests
{
    private const string Data = @"C:\Games\Fallout4\Data";
    private const string Instance = @"C:\MO2\Fallout4";

    private static RegisteredCopy Copy(
        string name, string origin, int? slot, bool enabled = true, bool winning = true) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), slot, enabled, winning);

    private static LoadOrder Order(params RegisteredCopy[] copies) =>
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
        Assert.Equal(LoadOrder.Empty, holder.Current);

        holder.Apply(Order(Copy("A.esp", "ModA", slot: 0)));
        Assert.Equal(["A.esp"], holder.Current.Participating.Select(c => c.Name));

        holder.Apply(Order(Copy("A.esp", "ModA", slot: 0, enabled: false)));
        Assert.Empty(holder.Current.Participating);
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
