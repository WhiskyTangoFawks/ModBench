using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class FormIdEditTests
{
    private const string FreeFormKey = "000F00:Fixture.esp";

    [Fact]
    public void EditingTheFormId_MovesTheRecordToTheNewFormKey_OldGoneAtTheWorkingTree_StillUsed_NewChangedSinceTheLastCommit()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), FreeFormKey);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(FreeFormKey, result.NewFormKey);
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.True(mod.Uses(mod.Npc.ToString()));
        Assert.NotNull(mod.Document(FreeFormKey));
        Assert.Contains(FreeFormKey, mod.ChangedFormKeys());
    }

    [Fact]
    public void EditingTheFormId_OfANeverCommittedAddedRecord_LeavesTheOldFormKeyUnused()
    {
        using var mod = SourceEditFixture.Tracked();
        const string oldFormKey = "800000:Fixture.esp";
        TrackedTree.Seed(mod.ModFolder, mod.Plugin, oldFormKey);

        var result = mod.EditHandler.SetFormId(mod.Plugin, oldFormKey, FreeFormKey);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Document(oldFormKey));
        Assert.False(mod.Uses(oldFormKey));
        Assert.NotNull(mod.Document(FreeFormKey));
    }

    [Fact]
    public void EditingTheFormId_ToTheOneItHas_WritesNothing_AndAnswersNoNewFormKey()
    {
        using var mod = SourceEditFixture.Tracked();
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(result.NewFormKey);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void EditingTheFormId_OfTheHeader_RefusesItAsReadOnly_WithoutTouchingTheSourceTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.SetFormId(mod.Plugin, headerFormKey, FreeFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Equal("'FormKey' is read-only: a plugin header's FormID names the plugin itself, not a record in it.", result.Message);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Theory]
    [InlineData("\"not-a-formkey\"")]
    [InlineData("2048")]
    [InlineData("null")]
    public void EditingTheFormId_ToAValueThatIsNoFormKey_RefusesAsTheCodecsRejection_NamingTheField(string json)
    {
        using var mod = SourceEditFixture.Tracked();
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "FormKey", JsonDocument.Parse(json).RootElement);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void EditingTheFormId_ToOneAnotherRecordHolds_RefusesItAsTaken()
    {
        using var mod = SourceEditFixture.Tracked();
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), mod.OtherNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
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
    public void EditingTheFormId_AfterTheLightFlagIsSetInTheSession_RefusesAValueAboveTheLightRangeImmediately()
    {
        using var mod = SourceEditFixture.Tracked();
        var header = $"000000:{SourceEditFixture.PluginName}";
        Assert.True(mod.EditHandler.Set(mod.Plugin, header, "IsSmallMaster", JsonDocument.Parse("true").RootElement).Applied);

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LightPluginFormIdOutOfRange, result.Refusal);
    }

    [Fact]
    public void EditingTheFormId_OnAnUnflaggedPlugin_Accepts_AValueAboveTheLightRange()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), "001000:Fixture.esp");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("001000:Fixture.esp", result.NewFormKey);
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
        var before = TrackedTree.Records(two.ReferencerModFolder, two.ReferencerPlugin);

        var result = two.EditHandler.SetFormId(two.ReferencerPlugin, two.Npc.ToString(), "000F00:Winner.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
        Assert.Equal("FormKey", result.Path);
        Assert.Contains("Base.esm", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(two.ReferencerModFolder, two.ReferencerPlugin));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void EditingTheFormId_LeavesAReferencerInAnotherMod_AsItWas_TrackedOrNot(bool trackReferencer)
    {
        using var two = TwoModReferenceFixture.Create(trackReferencer);
        var before = ReferencerState(two);

        var result = two.EditHandler.SetFormId(two.TargetPlugin, two.TargetRace.ToString(), "000F00:Base.esm");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(two.Document(two.TargetPlugin, result.NewFormKey.Require()));
        Assert.Equal(before, ReferencerState(two));
    }

    private static IReadOnlyList<string> ReferencerState(TwoModReferenceFixture two) =>
        SourceRepository.IsTracked(two.ReferencerModFolder)
            ? TrackedTree.Records(two.ReferencerModFolder, two.ReferencerPlugin)
            : [Convert.ToHexString(File.ReadAllBytes(Path.Combine(two.ReferencerModFolder, two.ReferencerPlugin.Name)))];

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
        var referencerBefore = TrackedTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "SamePluginNpc").Body;

        var result = mod.EditHandler.SetFormId(mod.Plugin, oldFormKey, newFormKey);

        Assert.True(result.Applied, result.Message);
        var formKeyLine = $"\"FormKey\": \"{oldFormKey}\"";
        Assert.Contains(formKeyLine, before, StringComparison.Ordinal);
        Assert.Contains($"\"MorphRace\": \"{oldFormKey}\"", before, StringComparison.Ordinal);
        Assert.Equal(
            before.Replace(formKeyLine, $"\"FormKey\": \"{newFormKey}\"", StringComparison.Ordinal),
            mod.Body(FormKey.Factory(newFormKey)));
        Assert.Equal(referencerBefore, TrackedTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "SamePluginNpc").Body);
    }

    [Fact]
    public void EditingTheFormId_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), FreeFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Run \"Modbench: Track Mod…\"", result.Message, StringComparison.Ordinal);
    }
}
