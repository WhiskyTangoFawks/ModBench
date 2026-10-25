using System.Globalization;
using System.Text;
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

public sealed class CreateRecordChangesHandlerTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_OnANeverCommittedRecord_LandsInTheTree()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var created = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");
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
    public void CreateRecord_WritesNothing_AndAnswersTheNewDocumentAndTheHeaderThatMovesTheNextObjectId()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var (outcome, changes) = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal(FixtureNextObjectId, outcome.NewFormKey);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
        Assert.Equal(0x807u, mod.NextObjectId());
        Assert.Empty(changes.Require().Moves);
        Assert.Empty(changes.Require().Deletions);
        Assert.Contains(changes.Require().Documents, document => document.Text.Contains(FixtureNextObjectId, StringComparison.Ordinal));
        var header = Assert.Single(changes.Require().Documents, document => document.Path == Path.Combine(mod.ModFolder, SourceModTree.HeaderDocumentFile(mod.ModFolder, mod.Plugin)));
        Assert.Equal(0x808u, HeaderDocument.NextObjectId(Encoding.UTF8.GetBytes(header.Text), GameRelease.Fallout4));
    }

    [Fact]
    public void CreateRecord_OverAnUnsavedHeader_TakesTheNextObjectIdItHolds()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var headerFile = Path.Combine(mod.ModFolder, SourceModTree.HeaderDocumentFile(mod.ModFolder, mod.Plugin));
        var unsavedHeader = Encoding.UTF8.GetString(
            HeaderDocument.WithNextObjectId(File.ReadAllBytes(headerFile), GameRelease.Fallout4, 0x900));

        mod.Unsaved.Apply([new DocumentChange(headerFile, unsavedHeader)]);

        var (outcome, _) = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");

        Assert.Equal("000900:Fixture.esp", outcome.NewFormKey);
    }

    public static TheoryData<Action<SourceEditFixture>, RecordEditRefusal> UnwritableTrees() => new()
    {
        { mod => TreeTampering.BlockWrite(mod.ModFolder, mod.Plugin, new RecordIdentity(FixtureNextObjectId, "npc_", null)), RecordEditRefusal.SourceAccessFailed },
        { mod => File.Delete(Path.Combine(mod.ModFolder, TreeTampering.HeaderDocumentOf(mod.Plugin.Name))), RecordEditRefusal.PluginSourceUnreadable },
    };

    [Theory]
    [MemberData(nameof(UnwritableTrees))]
    public void CreateRecord_OnATreeItCannotWrite_RefusesAndLeavesTheTreeAsItWas(Action<SourceEditFixture> damage, RecordEditRefusal refusal)
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        damage(mod);
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.Equal(refusal, result.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void CreateRecord_LandsEveryTypeTheCreatableListNames()
    {
        using var mod = SourceModFixture.CompiledPlugin("Creatable.esp", "CreatableMod", _ => { });
        var creatable = RecordTypes.For(GameRelease.Fallout4).Creatable;

        var refused = creatable
            .Select(type => (type, result: mod.CreateHandler.CreateRecordSync(mod.Plugin, type)))
            .Where(created => !created.result.Applied)
            .Select(created => $"{created.type}: {created.result.Message}");

        Assert.Empty(refused);
    }

    [Theory]
    [InlineData("refr", RecordEditRefusal.HeldInAnotherRecordNotYetSupported)]
    [InlineData("navm", RecordEditRefusal.HeldInAnotherRecordNotYetSupported)]
    [InlineData("not-a-real-type", RecordEditRefusal.RecordTypeNotFound)]
    [InlineData("header", RecordEditRefusal.RecordTypeNotFound)]
    public void CreateRecord_RefusesATypeTheCreatableListLeavesOut(string recordType, RecordEditRefusal refusal)
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        Assert.DoesNotContain(recordType, RecordTypes.For(GameRelease.Fallout4).Creatable);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, recordType);

        Assert.False(result.Applied);
        Assert.Equal(refusal, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OfACell_CarriesTheIsInteriorCellFlag()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "cell");

        var document = mod.Document(result.NewFormKey.Require()).Require();
        var flags = JsonNode.Parse(document.Body).Require()["Flags"].Require().AsArray();
        Assert.Contains(flags, flag => flag?.GetValue<string>() == "IsInteriorCell");
    }

    [Fact]
    public void CreateRecord_NamingAContainerThePluginLacks_RefusesRecordNotFound_NamingIt()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        const string gone = "000FFF:" + SourceEditFixture.PluginName;

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "refr", gone);

        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CreateRecord_WithAGridPositionAndNoWorldspace_RefusesAsAMalformedEnvelope(bool inACell)
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var container = inACell ? mod.Cell.ToString() : null;

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "cell", container, new GridPosition(0, 0));

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
    }

    [Fact]
    public void CreateRecord_AllocatesAFormKey_WritesAMinimalSourceFile_RecordBecomesReadable()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

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
        using var mod = SourceEditFixture.CompiledPlugin();

        var deleted = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);
        Assert.Empty(deleted.Refused);

        var created = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");
        Assert.True(created.Applied, created.Message);

        var npcs = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        Assert.DoesNotContain(npcs, n => n.Contains(SourceEditFixture.NpcEditorId, StringComparison.Ordinal));
        Assert.Contains(npcs, n => n.Contains("\"EditorID\": \"UntouchedNpc\"", StringComparison.Ordinal));
        Assert.NotNull(mod.Document(created.NewFormKey.Require()));
    }

    [Fact]
    public void CreateRecord_IsChangedSinceTheLastCommit_UntilCommitted()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.NotNull(result.NewFormKey);
        Assert.Contains(result.NewFormKey, mod.ChangedFormKeys());
        Commit(mod);
        Assert.DoesNotContain(result.NewFormKey, mod.ChangedFormKeys());
    }

    public static TheoryData<Action<SourceEditFixture>, string> NextObjectIdArrangements() => new()
    {
        { mod => Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.OtherNpc.ToString())]).Refused), FixtureNextObjectId },
        { mod => SourceModTree.Seed(mod.ModFolder, mod.Plugin, FixtureNextObjectId), "000808:Fixture.esp" },
        {
            mod =>
            {
                Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Quest.ToString())]).Refused);
                Commit(mod);
            },
            FixtureNextObjectId
        },
        {
            mod =>
            {
                var first = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_").NewFormKey.Require();
                Assert.Equal(FixtureNextObjectId, first);
                Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, first)]).Refused);
                Commit(mod);
            },
            "000808:Fixture.esp"
        },
    };

    [Theory]
    [MemberData(nameof(NextObjectIdArrangements))]
    public void CreateRecord_TakesTheFormKeyAtTheNextObjectId_OrTheFirstFreeAboveIt(Action<SourceEditFixture> arrange, string expected)
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        arrange(mod);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.Equal(expected, result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_AllocatesNoHigherBecauseOfAnOverrideOfAMastersRecord()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        const string masterKey = "F00000:Master.esm";
        SourceModTree.Repository(mod.ModFolder, mod.Plugin).Put(
            mod.Plugin,
            new SourceDocument(masterKey, "npc_", "Overridden", $"{{\n  \"FormKey\": \"{masterKey}\",\n  \"EditorID\": \"Overridden\"\n}}")).Wrote();

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.True(LocalId(result.NewFormKey) < LocalId(masterKey), result.NewFormKey);
    }

    private const string FixtureNextObjectId = "000807:Fixture.esp";

    private static void Commit(SourceEditFixture mod)
    {
        SourceModTree.Commit(mod.ModFolder);
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':', StringComparison.Ordinal)], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    [Fact]
    public void CreateRecord_Refuses_WhenPluginIsNonCompiledPlugin()
    {
        using var mod = SourceEditFixture.NonCompiledPlugin();

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotCompiledPlugin, result.Refusal);
    }

    [PosixFact]
    public void CreateRecord_WhenADocumentHoldingTheNextObjectIdCannotBeRead_RefusesAndWritesNothing()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var held = Path.Combine(mod.ModFolder, PluginSourceRoot.For(mod.Plugin.Name), "Npcs", "RenamedByHand.json");
        Directory.CreateDirectory(Path.GetDirectoryName(held).Require());
        File.WriteAllText(held, $"{{\"FormKey\": \"{FixtureNextObjectId}\", \"EditorID\": \"Hidden\"}}");
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);
        FileModes.Set(held, "000");

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        FileModes.Set(held, "644");
        Assert.Equal(RecordEditRefusal.SourceAccessFailed, result.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }

    public static TheoryData<Func<SourceEditFixture>, string, string> ExhaustedFormKeySpaces() => new()
    {
        {
            SourceEditFixture.CompiledPlugin, "FFFFFF:Fixture.esp",
            "Fixture.esp has no FormKey free at or above its Next Object ID, up to 0xFFFFFF."
        },
        {
            () => SourceEditFixture.CompiledPluginLight(), "000FFF:Fixture.esp",
            "Fixture.esp has no FormKey free at or above its Next Object ID, up to 0xFFF, the last a light plugin can " +
            "address. Clear the light flag to draw above it."
        },
        {
            () => SourceEditFixture.CompiledPluginLight("Fixture.esl"), "000FFF:Fixture.esl",
            "Fixture.esl has no FormKey free at or above its Next Object ID, up to 0xFFF, the last a light plugin can address. " +
            "Clear the light flag and rename the plugin off .esl to draw above it."
        },
    };

    [Theory]
    [MemberData(nameof(ExhaustedFormKeySpaces))]
    public void CreateRecord_WithNoFormKeyFreeAtOrAboveTheNextObjectId_RefusesNamingWhatCouldGiveRoom(
        Func<SourceEditFixture> plugin, string lastFormKey, string message)
    {
        using var mod = plugin();
        TakeTheNextObjectId(mod, lastFormKey);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
        Assert.Equal(message, result.Message);
    }

    [Theory]
    [InlineData("Fixture.esp")]
    [InlineData("Fixture.esl")]
    public void CreateRecord_OnALightPlugin_AllocatesUpToTheEslCap(string pluginName)
    {
        using var mod = SourceEditFixture.CompiledPluginLight(pluginName);
        TakeTheNextObjectId(mod, $"000FFE:{pluginName}");

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.True(result.Applied, result.Message);
        Assert.Equal($"000FFF:{pluginName}", result.NewFormKey);
    }

    private static void TakeTheNextObjectId(SourceEditFixture mod, string formKey)
    {
        SourceModTree.SetNextObjectId(mod.ModFolder, mod.Plugin, LocalId(formKey));
        SourceModTree.Seed(mod.ModFolder, mod.Plugin, formKey);
    }
}
