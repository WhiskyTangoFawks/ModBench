using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

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

        var result = mod.CopyHandler.CopySync([npc, faction], mode, [mod.DestinationPlugin, mod.SourcePlugin], replace: false);

        Assert.Equal(
            [new CopyItem(npc, mod.DestinationPlugin), new CopyItem(faction, mod.DestinationPlugin)],
            result.Landed.Select(landed => landed.Item));
        Assert.Equal(
            [new CopyItem(npc, mod.SourcePlugin), new CopyItem(faction, mod.SourcePlugin)],
            result.Refused.Select(refused => refused.Item));
        Assert.All(result.Refused, refused => Assert.Equal(RecordEditRefusal.PluginNotTracked, refused.Refusal));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CopyingAsOverride_OfARecordTheDestinationsTreeUsesButNoRecordAnswersTo_RefusesIt_AndTheOthersLand(bool replace)
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        var faction = new RecordAt(mod.SourcePlugin, mod.SelfLinkingFaction.ToString());
        TreeTampering.NameInAnUnplaceableChild(mod.DestinationModFolder, mod.DestinationPlugin, mod.SourceNpc.ToString());

        var result = mod.CopyHandler.CopySync([npc, faction], CopyMode.Override, [mod.DestinationPlugin], replace);

        Assert.Equal([new CopyItem(faction, mod.DestinationPlugin)], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(new CopyItem(npc, mod.DestinationPlugin), refused.Item);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, refused.Refusal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CopyingAsOverride_IntoTheRecordsOwnPlugin_WritesNothing_AndIsNoRefusal(bool replace)
    {
        using var mod = CopyFixture.Create(trackSource: true);
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        LeaveTextTheCodecWouldRespell(mod);
        var before = TrackedTree.Records(mod.SourceModFolder, mod.SourcePlugin);

        var result = mod.CopyHandler.CopySync([npc], CopyMode.Override, [mod.SourcePlugin], replace);

        Assert.Equal([new CopyItem(npc, mod.SourcePlugin)], result.Landed.Select(landed => landed.Item));
        Assert.Empty(result.Refused);
        Assert.Equal(before, TrackedTree.Records(mod.SourceModFolder, mod.SourcePlugin));
    }

    private static void LeaveTextTheCodecWouldRespell(CopyFixture mod)
    {
        var npc = mod.Document(mod.SourcePlugin, mod.SourceNpc.ToString()).Require();
        mod.Overwrite(mod.SourcePlugin, npc with { Body = npc.Body + "\n\n" });
    }

    [Fact]
    public void ARecordAndADestinationNamedTwice_AreCopiedOnce()
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        var sameDestination = new PluginAddress(
            mod.DestinationPlugin.Name.ToUpperInvariant(), mod.DestinationPlugin.Origin);

        var result = mod.CopyHandler.CopySync([npc, npc], CopyMode.New, [mod.DestinationPlugin, sameDestination], replace: false);

        Assert.Single(result.Landed);
        Assert.Empty(result.Refused);
    }
}
