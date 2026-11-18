using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

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

    [Fact]
    public void CopyingAsOverride_IntoAPluginTheRecordIndexHolds_ReadsNoOtherDocumentOfItsTree()
    {
        using var mod = CopyFixture.Create();
        var npc = new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString());
        mod.Index.Holds = (_, _) => false;
        TreeTampering.Stray(
            mod.DestinationModFolder, mod.DestinationPlugin, mod.Document(mod.DestinationPlugin, mod.DestinationNpc.ToString()).Require().Identity,
            "Unreadable.json", "{ \"FormKey\": \"no FormKey\" }");

        var result = mod.CopyHandler.CopySync([npc], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        Assert.Equal([new CopyItem(npc, mod.DestinationPlugin)], result.Applied.Select(applied => new CopyItem(applied.Record, applied.Destination)));
    }

    private sealed class TwoCopiesOfOneRecord : TestInstance
    {
        public PluginAddress Master { get; }
        public PluginAddress Override { get; }
        public PluginAddress Destination { get; }
        public string Npc { get; }

        public TwoCopiesOfOneRecord()
        {
            var master = new Fallout4Mod(ModKey.FromFileName("Master.esm"), Fallout4Release.Fallout4);
            var npc = master.Npcs.AddNew("SharedNpc");
            Master = Add(master, "MasterMod", compiledPlugin: false);
            var over = new Fallout4Mod(ModKey.FromFileName("Override.esp"), Fallout4Release.Fallout4);
            over.ModHeader.MasterReferences.Add(new MasterReference { Master = master.ModKey });
            over.Npcs.Set(npc.DeepCopy());
            Override = Add(over, "OverrideMod", compiledPlugin: false);
            Destination = Add(new Fallout4Mod(ModKey.FromFileName("Destination.esp"), Fallout4Release.Fallout4), "DestinationMod");
            Npc = npc.FormKey.ToString();
        }
    }

    [Fact]
    public void CopyingAsOverride_TwoCopiesOfOneRecordInOneSelection_WithoutReplace_RefusesTheSecond_ThoughTheRecordIndexHoldsNeither()
    {
        using var mod = new TwoCopiesOfOneRecord();
        mod.Index.Holds = (_, _) => false;

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.Master, mod.Npc), new RecordAt(mod.Override, mod.Npc)], CopyMode.Override, [mod.Destination], replace: false);

        Assert.Equal([mod.Master], result.Applied.Select(applied => applied.Record.Plugin));
        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, Assert.Single(result.Refused).Refusal);
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

        mod.Unsaved.Typed(unsaved);

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
