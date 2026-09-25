using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>What an edit of a record's FormID does to the working trees: its document moves to the
/// new FormKey and nothing else changes. The Index's answer afterwards is the Index suite's.</summary>
public sealed class FormIdEditTests
{
    private const string FreeFormKey = "000F00:Fixture.esp";

    [Fact]
    public void EditingTheFormId_MovesTheRecordToTheNewFormKey_OldGoneAtTheWorkingTree_StillAtHead_NewAbsentAtHead()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), FreeFormKey);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(FreeFormKey, result.NewFormKey);
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.NotNull(mod.CommittedDocument(mod.Npc.ToString(), "npc_", SourceEditFixture.NpcEditorId));
        Assert.NotNull(mod.Document(FreeFormKey));
        Assert.Null(mod.CommittedDocument(FreeFormKey, "npc_", SourceEditFixture.NpcEditorId));
    }

    [Fact]
    public void EditingTheFormId_OfANeverCommittedAddedRecord_LeavesTheOldFormKeyInNeitherRef()
    {
        using var mod = SourceEditFixture.Tracked();
        const string oldFormKey = "800000:Fixture.esp";
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNew", oldFormKey);
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.EditHandler.SetFormId(mod.Plugin, oldFormKey, FreeFormKey);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Document(oldFormKey));
        Assert.Null(mod.CommittedDocument(oldFormKey, "npc_", "BrandNew"));
        Assert.NotNull(mod.Document(FreeFormKey));
    }

    [Fact]
    public void EditingTheFormId_ToTheOneItHas_WritesNothing_AndAnswersNoNewFormKey()
    {
        using var mod = SourceEditFixture.Tracked();
        var before = TreeSnapshot.Of(mod.ModFolder);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(result.NewFormKey);
        Assert.Equal(before, TreeSnapshot.Of(mod.ModFolder));
    }

    [Fact]
    public void EditingTheFormId_OfTheHeader_RefusesItAsReadOnly_WithoutTouchingTheSourceTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));
        var before = TreeSnapshot.Of(mod.ModFolder);

        var result = mod.EditHandler.SetFormId(mod.Plugin, headerFormKey, FreeFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Equal(before, TreeSnapshot.Of(mod.ModFolder));
    }

    [Theory]
    [InlineData("\"not-a-formkey\"")]
    [InlineData("2048")]
    [InlineData("null")]
    public void EditingTheFormId_ToAValueThatIsNoFormKey_RefusesAsTheCodecsRejection_NamingTheField(string json)
    {
        using var mod = SourceEditFixture.Tracked();
        var before = TreeSnapshot.Of(mod.ModFolder);

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "FormKey", JsonDocument.Parse(json).RootElement);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Equal(before, TreeSnapshot.Of(mod.ModFolder));
    }

    [Fact]
    public void EditingTheFormId_ToOneAnotherRecordHolds_RefusesItAsTaken()
    {
        using var mod = SourceEditFixture.Tracked();
        var before = TreeSnapshot.Of(mod.ModFolder);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), mod.OtherNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(mod.ModFolder));
    }

    [Fact]
    public void EditingTheFormId_OnALightPlugin_Refuses_WhenTheValueExceedsTheLightRange()
    {
        using var mod = SourceEditFixture.TrackedLight();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LightPluginFormIdOutOfRange, result.Refusal);
    }

    [Fact]
    public void EditingTheFormId_Refuses_WhenTheValueNamesADifferentPlugin()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void EditingTheFormId_OfAnOverride_Refuses_NamingItsMaster()
    {
        using var two = TwoModReferenceFixture.Create(trackReferencer: true);
        var before = TreeSnapshot.Of(two.ReferencerModFolder);

        var result = two.EditHandler.SetFormId(two.ReferencerPlugin, two.Npc.ToString(), "000F00:Winner.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Contains("Base.esm", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(two.ReferencerModFolder));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void EditingTheFormId_LeavesAReferencerInAnotherMod_AsItWas_TrackedOrNot(bool trackReferencer)
    {
        using var two = TwoModReferenceFixture.Create(trackReferencer);
        var before = TreeSnapshot.Of(two.ReferencerModFolder);

        var result = two.EditHandler.SetFormId(two.TargetPlugin, two.TargetRace.ToString(), "000F00:Base.esm");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(two.Document(two.TargetPlugin, result.NewFormKey.Require()));
        Assert.Equal(before, TreeSnapshot.Of(two.ReferencerModFolder));
    }

    [Fact]
    public void EditingTheFormId_ChangesOnlyTheFormKey_LeavingItsOwnLinkAndItsPluginsOtherRecordsAsTheyWere()
    {
        const string pluginName = "SelfLinked.esp";
        const string newFormKey = "000F00:SelfLinked.esp";
        var race = FormKey.Null;
        using var mod = SourceModFixture.Tracked(pluginName, "SelfLinkedMod", m =>
        {
            var morphing = m.Races.AddNew("MorphingRace");
            morphing.MorphRace.SetTo(morphing);
            m.Npcs.AddNew("SamePluginNpc").Race.SetTo(morphing);
            race = morphing.FormKey;
        });
        var oldFormKey = race.ToString();
        var before = mod.Body(race);
        var referencer = Directory
            .EnumerateFiles(Path.Combine(mod.ModFolder, SourceRepository.RootFor(pluginName)), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains("SamePluginNpc", StringComparison.Ordinal));
        var referencerBefore = File.ReadAllText(referencer);

        var result = mod.EditHandler.SetFormId(mod.Plugin, oldFormKey, newFormKey);

        Assert.True(result.Applied, result.Message);
        var formKeyLine = $"\"FormKey\": \"{oldFormKey}\"";
        Assert.Contains(formKeyLine, before, StringComparison.Ordinal);
        Assert.Contains($"\"MorphRace\": \"{oldFormKey}\"", before, StringComparison.Ordinal);
        Assert.Equal(
            before.Replace(formKeyLine, $"\"FormKey\": \"{newFormKey}\"", StringComparison.Ordinal),
            mod.Body(FormKey.Factory(newFormKey)));
        Assert.Equal(referencerBefore, File.ReadAllText(referencer));
    }

    [Fact]
    public void EditingTheFormId_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), FreeFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingTheFormId_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = SourceEditFixture.Tracked();
        mod.RaiseExternalChange();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), FreeFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
    }
}
