using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.TestSupport;

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
    }

    // commands.md, Doing nothing is not an error: a record's own plugin already is that copy, so
    // an override into it writes nothing, with or without the replace Option.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CopyingAsOverride_IntoTheRecordsOwnPlugin_WritesNothing_AndIsNoRefusal(bool replace)
    {
        using var mod = CopyFixture.Create(trackSource: true);
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        LeaveTextTheCodecWouldRespell(mod.SourceFileFor(mod.SourcePlugin, mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId));
        var before = TreeSnapshot.Of(mod.SourceModFolder);

        var result = mod.CopyHandler.Copy([npc], CopyMode.Override, [mod.SourcePlugin], replace);

        Assert.Equal([new CopyItem(npc, mod.SourcePlugin)], result.Applied.Select(landed => landed.Item));
        Assert.Empty(result.Refused);
        Assert.Equal(before, TreeSnapshot.Of(mod.SourceModFolder));
    }

    private static void LeaveTextTheCodecWouldRespell(string document) => File.AppendAllText(document, "\n\n");

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
