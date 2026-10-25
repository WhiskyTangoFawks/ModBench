using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyRecordChangesHandlerTests
{
    [Theory]
    [InlineData(CopyMode.New)]
    [InlineData(CopyMode.Override)]
    public void CopyingTwoRecordsIntoTwoDestinations_WhereOneIsNonCompiledPlugin_LandsInTheCompiledPluginOne_AndAnswersPerItem(CopyMode mode)
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        var faction = new RecordAt(mod.SourcePlugin, mod.SelfLinkingFaction.ToString());

        var result = mod.CopyHandler.CopySync([npc, faction], mode, [mod.DestinationPlugin, mod.SourcePlugin], replace: false);

        Assert.Equal(
            [new CopyItem(npc, mod.DestinationPlugin), new CopyItem(faction, mod.DestinationPlugin)],
            result.Applied.Select(applied => new CopyItem(applied.Record, applied.Destination)));
        Assert.Equal(
            [new CopyItem(npc, mod.SourcePlugin), new CopyItem(faction, mod.SourcePlugin)],
            result.Refused.Select(refused => refused.Item));
        Assert.All(result.Refused, refused => Assert.Equal(RecordEditRefusal.PluginNotCompiledPlugin, refused.Refusal));
    }

    [Theory]
    [InlineData(CopyMode.New)]
    [InlineData(CopyMode.Override)]
    public void Copying_ARecordTheSourcePluginDoesNotHold_IsRefusedAsNotFound(CopyMode mode)
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, $"ABCDEF:{CopyFixture.SourcePluginName}")], mode, [mod.DestinationPlugin], replace: false);

        Assert.Equal(RecordEditRefusal.RecordNotFound, result.OnlyRefused().Refusal);
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

        Assert.Equal([new CopyItem(faction, mod.DestinationPlugin)], result.Applied.Select(applied => new CopyItem(applied.Record, applied.Destination)));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(new CopyItem(npc, mod.DestinationPlugin), refused.Item);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, refused.Refusal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CopyingAsOverride_IntoTheRecordsOwnPlugin_WritesNothing_AndIsNoRefusal(bool replace)
    {
        using var mod = CopyFixture.Create(initSource: true);
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        LeaveTextTheCodecWouldRespell(mod);
        var before = SourceModTree.Records(mod.SourceModFolder, mod.SourcePlugin);

        var result = mod.CopyHandler.CopySync([npc], CopyMode.Override, [mod.SourcePlugin], replace);

        Assert.Equal([new CopyItem(npc, mod.SourcePlugin)], result.Applied.Select(applied => new CopyItem(applied.Record, applied.Destination)));
        Assert.Empty(result.Refused);
        Assert.Equal(before, SourceModTree.Records(mod.SourceModFolder, mod.SourcePlugin));
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

        Assert.Single(result.Applied);
        Assert.Empty(result.Refused);
    }

    [Fact]
    public async Task CopyingAsNew_WithReplace_RefusesTheSelection_AndWritesNothing()
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        var before = SourceModTree.Records(mod.DestinationModFolder, mod.DestinationPlugin);

        var refusal = (await mod.CopyHandler.CopyRecords([npc], CopyMode.New, [mod.DestinationPlugin], replace: true)).WholeSelectionRefusal();

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, refusal.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.DestinationModFolder, mod.DestinationPlugin));
    }

    [Theory]
    [InlineData(CopyMode.New)]
    [InlineData(CopyMode.Override)]
    public void CopyChanges_AnswerTheDestinationsDocuments_AndWriteNothing(CopyMode mode)
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        var before = SourceModTree.Records(mod.DestinationModFolder, mod.DestinationPlugin);

        var result = mod.CopyHandler.CopyChangesSync([npc], mode, [mod.DestinationPlugin], replace: false);

        var changes = Assert.Single(result.Applied);
        Assert.NotEmpty(changes.Documents);
        Assert.All(changes.Documents, document => Assert.StartsWith(mod.DestinationModFolder, document.Path, StringComparison.Ordinal));
        Assert.Equal(before, SourceModTree.Records(mod.DestinationModFolder, mod.DestinationPlugin));
    }

    [Fact]
    public void CopyChanges_OfACompiledPluginSourcesRecord_CarryTheSourcesUnsavedText()
    {
        using var mod = CopyFixture.Create(initSource: true);
        var npc = mod.Document(mod.SourcePlugin, mod.SourceNpc.ToString()).Require();
        var unsaved = new DocumentChange(
            TreeTampering.FileOf(mod.SourceModFolder, mod.SourcePlugin, npc.Identity),
            npc.Body.Replace(CopyFixture.SourceNpcEditorId, "UnsavedNpc", StringComparison.Ordinal));

        mod.Unsaved.Apply([unsaved]);

        var result = mod.CopyHandler.CopyChangesSync(
            [new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        var changes = Assert.Single(result.Applied);
        Assert.Contains(changes.Documents, document => document.Text.Contains("UnsavedNpc", StringComparison.Ordinal));
    }

    [Fact]
    public void CopyingTwoRecordsAsNewIntoOneDestination_DrawsEachItsOwnFormKey_FromTheOnesBeforeIt()
    {
        using var mod = CopyFixture.Create();
        var records = new[] { mod.SourceNpc, mod.SelfLinkingFaction }.Select(key => new RecordAt(mod.SourcePlugin, key.ToString())).ToList();

        var result = mod.CopyHandler.CopyChangesSync(records, CopyMode.New, [mod.DestinationPlugin], replace: false);

        var drawn = result.Applied.Select(applied => applied.NewFormKey).ToList();
        Assert.Equal(2, drawn.Distinct().Count());
    }
}
