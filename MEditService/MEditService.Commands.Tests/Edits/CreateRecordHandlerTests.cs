using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreateRecordHandlerTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_OnANeverCommittedRecord_LandsInTheTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");
        Assert.True(created.Applied, created.Message);
        Assert.NotNull(created.NewFormKey);
        var newFormKey = created.NewFormKey;

        var result = mod.EditHandler.Set(mod.Plugin, newFormKey, "EditorID", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        var document = mod.Document(newFormKey);
        Assert.NotNull(document);
        Assert.Equal("RenamedNpc", document.EditorId);
        Assert.Contains("RenamedNpc", document.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_WhenTheFileSystemRefusesTheWrite_RefusesWithItsWords_AndLeavesTheTreeAsItWas()
    {
        using var mod = SourceEditFixture.Tracked();
        const string newFormKey = "000807:Fixture.esp";
        TreeTampering.BlockWrite(mod.ModFolder, mod.Plugin, new RecordIdentity(newFormKey, "npc_", null));
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(RecordEditRefusal.SourceAccessFailed, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void CreateRecord_LandsEveryTypeTheCreatableListNames()
    {
        using var mod = SourceModFixture.Tracked("Creatable.esp", "CreatableMod", _ => { });
        var creatable = RecordTypes.For(GameRelease.Fallout4).Creatable;

        var refused = creatable
            .Select(type => (type, result: mod.CreateHandler.CreateRecord(mod.Plugin, type)))
            .Where(created => !created.result.Applied)
            .Select(created => $"{created.type}: {created.result.Message}");

        Assert.Empty(refused);
    }

    [Theory]
    [InlineData("refr")]
    [InlineData("navm")]
    public void CreateRecord_RefusesATypeTheCreatableListLeavesOut(string recordType)
    {
        using var mod = SourceEditFixture.Tracked();
        Assert.DoesNotContain(recordType, RecordTypes.For(GameRelease.Fallout4).Creatable);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, recordType);

        Assert.Equal(RecordEditRefusal.HeldInAnotherRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OfACell_CarriesTheIsInteriorCellFlag()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "cell");

        var document = mod.Document(result.NewFormKey.Require()).Require();
        var flags = JsonNode.Parse(document.Body).Require()["Flags"].Require().AsArray();
        Assert.Contains(flags, flag => flag?.GetValue<string>() == "IsInteriorCell");
    }

    [Fact]
    public void CreateRecord_NamingAContainerThePluginLacks_RefusesRecordNotFound_NamingIt()
    {
        using var mod = SourceEditFixture.Tracked();
        const string gone = "000FFF:" + SourceEditFixture.PluginName;

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "refr", gone);

        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CreateRecord_WithAGridPositionAndNoWorldspace_RefusesAsAMalformedEnvelope(bool inACell)
    {
        using var mod = SourceEditFixture.Tracked();
        var container = inACell ? mod.Cell.ToString() : null;

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "cell", container, new GridPosition(0, 0));

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
    }

    [Fact]
    public void CreateRecord_AllocatesAFormKey_WritesAMinimalSourceFile_RecordBecomesReadable()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var newFormKey = result.NewFormKey;
        Assert.EndsWith(":" + SourceEditFixture.PluginName, newFormKey, StringComparison.Ordinal);

        var document = mod.Document(newFormKey);
        Assert.NotNull(document);
        Assert.Null(document.EditorId);
    }

    [Fact]
    public void CreateRecord_AfterAnEarlierSiblingWasDeleted_LandsContiguously_NoGapSurvivesToLandPast()
    {
        using var mod = SourceEditFixture.Tracked();

        var deleted = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);
        Assert.Empty(deleted.Refused);

        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");
        Assert.True(created.Applied, created.Message);

        var npcs = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        Assert.DoesNotContain(npcs, n => n.Contains(SourceEditFixture.NpcEditorId, StringComparison.Ordinal));
        Assert.Contains(npcs, n => n.Contains("\"EditorID\": \"UntouchedNpc\"", StringComparison.Ordinal));
        Assert.NotNull(mod.Document(created.NewFormKey.Require()));
    }

    [Fact]
    public void CreateRecord_IsChangedSinceTheLastCommit_UntilCommitted()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.NotNull(result.NewFormKey);
        Assert.Contains(result.NewFormKey, mod.ChangedFormKeys());
        Commit(mod);
        Assert.DoesNotContain(result.NewFormKey, mod.ChangedFormKeys());
    }

    [Fact]
    public void CreateRecord_TakesTheNextObjectId_ThoughAFormKeyBelowItIsFree()
    {
        using var mod = SourceEditFixture.Tracked();
        Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.OtherNpc.ToString())]).Refused);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(FixtureNextObjectId, result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_SkipsAFormKeyAtTheNextObjectIdThatARecordUses()
    {
        using var mod = SourceEditFixture.Tracked();
        TrackedTree.Seed(mod.ModFolder, mod.Plugin, FixtureNextObjectId);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal("000808:Fixture.esp", result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_NeverTakesTheFormKeyOfARecordDeletedAndCommitted()
    {
        using var mod = SourceEditFixture.Tracked();
        Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Quest.ToString())]).Refused);
        Commit(mod);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(FixtureNextObjectId, result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_MovesTheNextObjectIdPastTheFormKeyItTakes()
    {
        using var mod = SourceEditFixture.Tracked();
        var first = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_").NewFormKey.Require();
        Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, first)]).Refused);
        Commit(mod);

        var second = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(FixtureNextObjectId, first);
        Assert.Equal("000808:Fixture.esp", second.NewFormKey);
    }

    [Fact]
    public void CreateRecord_AllocatesNoHigherBecauseOfAnOverrideOfAMastersRecord()
    {
        using var mod = SourceEditFixture.Tracked();
        const string masterKey = "F00000:Master.esm";
        TrackedTree.Repository(mod.ModFolder).Put(
            mod.Plugin,
            new SourceDocument(masterKey, "npc_", "Overridden", $"{{\n  \"FormKey\": \"{masterKey}\",\n  \"EditorID\": \"Overridden\"\n}}"));

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.True(LocalId(result.NewFormKey) < LocalId(masterKey), result.NewFormKey);
    }

    private const string FixtureNextObjectId = "000807:Fixture.esp";

    private static void Commit(SourceEditFixture mod)
    {
        TrackedTree.Commit(mod.ModFolder);
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':', StringComparison.Ordinal)], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    [Fact]
    public void CreateRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Track its mod", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForAnUnknownRecordType()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "not-a-real-type");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForTheHeaderPseudoType()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "header");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OnATreeWithNoHeaderDocument_RefusesAsUnreadable_AndWritesNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        File.Delete(Path.Combine(mod.ModFolder, TreeTampering.HeaderDocumentOf(mod.Plugin.Name)));
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void CreateRecord_OnAFullPlugin_WithNoFormKeyFreeAtOrAboveTheNextObjectId_RefusesSayingSo_NamingNoRemedy()
    {
        using var mod = SourceEditFixture.Tracked();
        TakeTheNextObjectId(mod, "FFFFFF:Fixture.esp");

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
        Assert.Equal("Fixture.esp has no FormKey free at or above its Next Object ID, up to 0xFFFFFF.", result.Message);
    }

    private static void TakeTheNextObjectId(SourceEditFixture mod, string formKey)
    {
        TrackedTree.SetNextObjectId(mod.ModFolder, mod.Plugin, LocalId(formKey));
        TrackedTree.Seed(mod.ModFolder, mod.Plugin, formKey);
    }


    [Fact]
    public void CreateRecord_OnALightEspPlugin_Refuses_WhenTheEslRangeIsExhausted()
    {
        using var mod = SourceEditFixture.TrackedLight();
        TakeTheNextObjectId(mod, "000FFF:Fixture.esp");

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OnALightPlugin_WithNoFormKeyFreeAtOrAboveTheNextObjectId_NamesClearingTheLightFlag()
    {
        using var mod = SourceEditFixture.TrackedLight();
        TakeTheNextObjectId(mod, "000FFF:Fixture.esp");

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(
            "Fixture.esp has no FormKey free at or above its Next Object ID, up to 0xFFF, the last a light plugin can " +
            "address. Clear the light flag in the header to draw above it.",
            result.Message);
    }

    [Fact]
    public void CreateRecord_OnALightEspPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight();
        TakeTheNextObjectId(mod, "000FFE:Fixture.esp");

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esp", result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_OnAnEslPlugin_WithNoFormKeyFreeAtOrAboveTheNextObjectId_NamesNoRemedy_SinceItsExtensionKeepsItLight()
    {
        using var mod = SourceEditFixture.TrackedLight("Fixture.esl");
        TakeTheNextObjectId(mod, "000FFF:Fixture.esl");

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
        Assert.Equal(
            "Fixture.esl has no FormKey free at or above its Next Object ID, up to 0xFFF, the last a light plugin can address.",
            result.Message);
    }

    [Fact]
    public void CreateRecord_OnAPlainEslPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight("Fixture.esl");
        TakeTheNextObjectId(mod, "000FFE:Fixture.esl");

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esl", result.NewFormKey);
    }

}
