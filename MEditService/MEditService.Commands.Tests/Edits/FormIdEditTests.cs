using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class FormIdEditTests
{
    private const string FreeFormKey = "000F00:Fixture.esp";

    [Fact]
    public void EditingTheFormId_MovesTheRecordToTheNewFormKey_OldGoneAtTheWorkingTree_NewChangedSinceTheLastCommit()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), FreeFormKey);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(FreeFormKey, result.NewFormKey);
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.NotNull(mod.Document(FreeFormKey));
        Assert.Contains(FreeFormKey, mod.ChangedFormKeys());
    }

    [Fact]
    public void EditingTheFormId_ToTheOneItHas_IsApplied_AndAnswersNoNewFormKey()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(result.NewFormKey);
    }

    [Fact]
    public void EditingTheFormId_OfTheHeader_RefusesItAsFieldReadOnly_WithItsMessage_AndAnswersNoChanges()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.SetFormId(mod.Plugin, headerFormKey, FreeFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Equal("'FormKey' is read-only: a plugin header's FormID names the plugin itself, not a record in it.", result.Message);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Theory]
    [InlineData("\"not-a-formkey\"")]
    [InlineData("2048")]
    [InlineData("null")]
    public void EditingTheFormId_ToAValueThatIsNoFormKey_RefusesAsTheCodecsRejection_NamingTheField(string json)
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "FormKey", JsonDocument.Parse(json).RootElement);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void EditingTheFormId_ToOneAnotherRecordHolds_RefusesItAsTaken()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), mod.OtherNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Theory]
    [InlineData("Fixture.esp", "clear the light flag.")]
    [InlineData("Fixture.esl", "clear the light flag and rename the plugin off .esl.")]
    public void EditingTheFormId_OnALightPlugin_PastTheLightRange_IsRefused_NamingEveryWayToLiftTheLimit(string pluginName, string lift)
    {
        using var mod = SourceEditFixture.CompiledPluginLight(pluginName);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), $"001000:{pluginName}");

        Assert.Equal(
            (RecordEditRefusal.FormIdOutsideFlagLimit,
             $"001000:{pluginName} exceeds {pluginName}'s light local FormID range — a light plugin can only address local FormIDs " +
             $"up to 0xFFF. Choose a FormID within that range, or {lift}"),
            (result.Refusal, result.Message));
    }

    [Fact]
    public void EditingTheFormId_OnALightPluginWhoseHeaderVersionKeepsItsRangeAbove0x800_RefusesAValueBelowIt()
    {
        using var mod = SourceEditFixture.CompiledPluginLight();
        var headerFile = Path.Combine(mod.ModFolder, PluginSourceRoot.HeaderDocument(mod.Plugin.Name));
        var header = JsonNode.Parse(File.ReadAllText(headerFile)).Require();
        header["ModHeader"].Require()["Stats"].Require()["Version"] = 0.95f;
        File.WriteAllText(headerFile, header.ToJsonString());

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "000700:Fixture.esp");

        Assert.Equal(
            (RecordEditRefusal.FormIdOutsideFlagLimit,
             "000700:Fixture.esp is below Fixture.esp's light local FormID range, 0x800-0xFFF. Choose a FormID within that range."),
            (result.Refusal, result.Message));
    }

    [Fact]
    public void EditingTheFormId_AfterTheLightFlagIsSetInTheSession_RefusesAValueAboveTheLightRangeImmediately()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var header = $"000000:{SourceEditFixture.PluginName}";
        Assert.True(mod.EditHandler.Set(mod.Plugin, header, "IsSmallMaster", JsonDocument.Parse("true").RootElement).Applied);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormIdOutsideFlagLimit, result.Refusal);
    }

    [Fact]
    public void EditingTheFormId_OnAnUnflaggedPlugin_Accepts_AValueAboveTheLightRange()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "001000:Fixture.esp");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("001000:Fixture.esp", result.NewFormKey);
    }

    [Fact]
    public void EditingTheFormId_Refuses_WhenTheValueNamesADifferentPlugin()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void EditingTheFormId_OfAnOverride_Refuses_NamingItsMaster()
    {
        using var two = TwoModReferenceFixture.Create(initReferencer: true);
        var before = SourceModTree.Records(two.ReferencerModFolder, two.ReferencerPlugin);

        var result = two.EditHandler.SetFormId(two.ReferencerPlugin, two.Npc.ToString(), "000F00:Winner.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Contains("Base.esm", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, SourceModTree.Records(two.ReferencerModFolder, two.ReferencerPlugin));
    }

    [Fact]
    public void EditingTheFormId_CarriesAReferencerInAnotherModsPluginSource_AndLeavesNothingBehind()
    {
        using var two = TwoModReferenceFixture.Create(initReferencer: true);
        var oldFormKey = two.TargetRace.ToString();
        var referencerBefore = two.DocumentCarrying(two.ReferencerPlugin, TwoModReferenceFixture.ReferencerNpcEditorId).Body;

        var changes = TargetRaceRekeyed(two);
        EditSaving.Save(changes.Moves.Select(move => (move.From, move.To)), changes.Deletions, changes.Documents.Select(document => (document.Path, document.Text)));

        Assert.Empty(changes.LeftBehind);
        Assert.Contains($"\"Race\": \"{oldFormKey}\"", referencerBefore, StringComparison.Ordinal);
        Assert.Equal(
            referencerBefore.Replace(oldFormKey, "000F00:Base.esm", StringComparison.Ordinal),
            two.DocumentCarrying(two.ReferencerPlugin, TwoModReferenceFixture.ReferencerNpcEditorId).Body);
    }

    [Fact]
    public void EditingTheFormId_LeavesAReferencerInAPluginWithNoPluginSource_AsItWas()
    {
        using var two = TwoModReferenceFixture.Create(initReferencer: false);
        var binary = Path.Combine(two.ReferencerModFolder, two.ReferencerPlugin.Name);
        var before = File.ReadAllBytes(binary);

        var result = two.EditHandler.SetFormId(two.TargetPlugin, two.TargetRace.ToString(), "000F00:Base.esm");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(before, File.ReadAllBytes(binary));
    }

    [Fact]
    public void EditingTheFormId_LeavesBehindAPluginSourceThatCannotBeRead_NamingWhy_AndStillChangesTheRecord()
    {
        using var two = TwoModReferenceFixture.Create(initReferencer: true);
        var referencer = two.DocumentCarrying(two.ReferencerPlugin, TwoModReferenceFixture.ReferencerNpcEditorId);
        var referencerFile = SourceModTree.DocumentFile(two.ReferencerModFolder, two.ReferencerPlugin, referencer.FormKey).Require();
        var unreadable = Path.Combine(two.ReferencerModFolder, Path.GetDirectoryName(referencerFile).Require(), "Broken.json");
        File.WriteAllText(unreadable, "{ not json");

        var changes = TargetRaceRekeyed(two);

        var left = Assert.Single(changes.LeftBehind);
        Assert.Equal(two.ReferencerPlugin, left.Plugin);
        Assert.Contains("Broken.json", left.Reason, StringComparison.Ordinal);
        Assert.Equal("000F00:Base.esm", changes.NewFormKey);
        Assert.DoesNotContain(changes.Documents, document => document.Path.StartsWith(two.ReferencerModFolder, StringComparison.Ordinal));
    }

    [Fact]
    public void AScriptsEditOfTheFormId_WritesOneFolder_LeavingAReferencerInAnotherModsPluginSourceAsItWas()
    {
        using var two = TwoModReferenceFixture.Create(initReferencer: true);
        var before = SourceModTree.Records(two.ReferencerModFolder, two.ReferencerPlugin);

        var result = two.ScriptEditHandler.Edit(
            two.TargetPlugin, two.TargetRace.ToString(), Envelopes.SetAt(JsonSerializer.SerializeToElement("000F00:Base.esm"), Envelopes.Member("FormKey")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(before, SourceModTree.Records(two.ReferencerModFolder, two.ReferencerPlugin));
    }

    private static EditRecordChanges TargetRaceRekeyed(TwoModReferenceFixture two)
    {
        var envelope = Envelopes.SetAt(JsonSerializer.SerializeToElement("000F00:Base.esm"), Envelopes.Member("FormKey"));
        Assert.True(two.EditChangesHandler.Changes(two.TargetPlugin, two.TargetRace.ToString(), envelope).Holds(out var changes, out var refused), refused?.Message);
        return changes;
    }

    [Fact]
    public void EditingTheFormId_CarriesItsOwnLinkAndItsPluginsOtherRecords()
    {
        const string pluginName = "SelfLinked.esp";
        const string newFormKey = "000F00:SelfLinked.esp";
        var race = FormKey.Null;
        using var mod = SourceModFixture.CompiledPlugin(pluginName, "SelfLinkedMod", m =>
        {
            var morphing = m.Races.AddNew("MorphingRace");
            morphing.MorphRace.SetTo(morphing);
            m.Npcs.AddNew("SamePluginNpc").Race.SetTo(morphing);
            race = morphing.FormKey;
        });
        var oldFormKey = race.ToString();
        var before = mod.Body(race);
        var referencerBefore = SourceModTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "SamePluginNpc").Body;

        var result = mod.EditHandler.SetFormId(mod.Plugin, oldFormKey, newFormKey);

        Assert.True(result.Applied, result.Message);
        Assert.Contains($"\"MorphRace\": \"{oldFormKey}\"", before, StringComparison.Ordinal);
        Assert.Contains($"\"Race\": \"{oldFormKey}\"", referencerBefore, StringComparison.Ordinal);
        Assert.Equal(before.Replace(oldFormKey, newFormKey, StringComparison.Ordinal), mod.Body(FormKey.Factory(newFormKey)));
        Assert.Equal(
            referencerBefore.Replace(oldFormKey, newFormKey, StringComparison.Ordinal),
            SourceModTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "SamePluginNpc").Body);
    }

    [Fact]
    public void EditingTheFormId_MovesTheNextObjectIdPastTheNewFormKey()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "000F00:Fixture.esp");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(0xF01u, mod.NextObjectId());
    }

    [Fact]
    public void EditingTheFormId_OnATreeWithNoHeaderDocument_RefusesAsUnreadable_AndWritesNothing()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        File.Delete(Path.Combine(mod.ModFolder, TreeTampering.HeaderDocumentOf(mod.Plugin.Name)));
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), FreeFormKey);

        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, result.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }
}
