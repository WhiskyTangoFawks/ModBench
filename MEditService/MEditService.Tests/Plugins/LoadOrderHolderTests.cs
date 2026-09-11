using MEditService.Core.Plugins;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

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
        var applied = new LoadOrder(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, []);

        holder.Apply(applied);

        Assert.Same(applied, holder.Require());
    }

    [Fact]
    public void Require_AfterApplyingTheEmptyValue_RefusesAgain()
    {
        // Closing the load order applies Empty; a read after it must refuse exactly as it did
        // before the first snapshot.
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrder(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, []));

        holder.Apply(LoadOrder.Empty);

        Assert.Throws<NoLoadOrderException>(() => holder.Require());
    }
}
