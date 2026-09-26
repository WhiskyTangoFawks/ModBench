using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.Edits;

/// <summary>commands.md, A selection is one gesture: copy takes every record and every destination
/// at once, and each record lands in each destination or is refused on its own.</summary>
public sealed class CopyRecordHandlerTests
{
    [Theory]
    [InlineData(CopyMode.New)]
    [InlineData(CopyMode.Override)]
    public void CopyingTwoRecordsIntoTwoDestinations_WhereOneIsUntracked_LandsInTheTrackedOne_AndAnswersPerItem(CopyMode mode)
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        var faction = new RecordAt(mod.SourcePlugin, mod.SelfLinkingFaction.ToString());

        var result = mod.CopyHandler.Copy([npc, faction], mode, [mod.DestinationPlugin, mod.SourcePlugin], replace: false);

        Assert.Equal(
            [new CopyItem(npc, mod.DestinationPlugin), new CopyItem(faction, mod.DestinationPlugin)],
            result.Applied.Select(landed => landed.Item));
        Assert.Equal(
            [new CopyItem(npc, mod.SourcePlugin), new CopyItem(faction, mod.SourcePlugin)],
            result.Refused.Select(refused => refused.Item));
        Assert.All(result.Refused, refused => Assert.Equal(RecordEditRefusal.PluginNotTracked, refused.Refusal));
        Assert.All(result.Applied, landed => Assert.NotNull(
            mod.Document(mod.DestinationPlugin, landed.NewFormKey ?? landed.Item.Record.FormKey)));
    }

    [Fact]
    public void CopyingAsNew_AnswersEachLandedItemWithItsNewFormKey()
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());

        var result = mod.CopyHandler.Copy([npc], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var landed = Assert.Single(result.Applied);
        Assert.NotNull(landed.NewFormKey);
        Assert.NotEqual(npc.FormKey, landed.NewFormKey);
    }

    [Fact]
    public void CopyingAsOverride_AnswersEachLandedItemWithNoNewFormKey()
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());

        var result = mod.CopyHandler.Copy([npc], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        Assert.Null(Assert.Single(result.Applied).NewFormKey);
    }

    [Fact]
    public void ARecordAndADestinationNamedTwice_AreCopiedOnce()
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        var sameDestination = new PluginAddress(
            mod.DestinationPlugin.Name.ToUpperInvariant(), mod.DestinationPlugin.Origin);

        var result = mod.CopyHandler.Copy([npc, npc], CopyMode.New, [mod.DestinationPlugin, sameDestination], replace: false);

        Assert.Single(result.Applied);
        Assert.Empty(result.Refused);
    }
}
