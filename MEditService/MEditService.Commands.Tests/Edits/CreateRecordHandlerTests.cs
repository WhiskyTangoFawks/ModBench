using System.Globalization;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreateRecordHandlerTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_OnANeverCommittedRecord_LandsInTheTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");
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
    public void CreateRecord_LandsEveryTypeTheCreatableListNames()
    {
        using var mod = SourceEditFixture.Tracked();
        var creatable = CreatableRecordTypes.Of(SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4), GameRelease.Fallout4);

        var refused = creatable
            .Select(type => (type, result: mod.CreateHandler.CreateRecord(mod.Plugin, type, editorId: null)))
            .Where(created => !created.result.Applied)
            .Select(created => $"{created.type}: {created.result.Message}");

        Assert.Empty(refused);
    }

    [Theory]
    [InlineData("cell")]
    [InlineData("refr")]
    [InlineData("qust")]
    public void CreateRecord_RefusesATypeTheCreatableListLeavesOut(string recordType)
    {
        using var mod = SourceEditFixture.Tracked();
        Assert.DoesNotContain(recordType, CreatableRecordTypes.Of(SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4), GameRelease.Fallout4));

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, recordType, editorId: null);

        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void CreateRecord_AllocatesAFormKey_WritesAMinimalSourceFile_RecordBecomesReadable()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var newFormKey = result.NewFormKey;
        Assert.EndsWith(":" + SourceEditFixture.PluginName, newFormKey, StringComparison.Ordinal);

        var sourceFile = Path.Combine(mod.ModFolder, mod.RelativeSourcePath(
            FormKey.Factory(newFormKey), "npc_", "BrandNewNpc"));
        Assert.True(File.Exists(sourceFile));
        var document = mod.Document(newFormKey);
        Assert.NotNull(document);
        Assert.Equal("BrandNewNpc", document.EditorId);
    }

    [Fact]
    public void CreateRecord_AfterAnEarlierSiblingWasDeleted_LandsContiguously_NoGapSurvivesToLandPast()
    {
        using var mod = SourceEditFixture.Tracked();

        var deleted = mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, mod.Npc.ToString())]);
        Assert.Empty(deleted.Refused);

        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AfterTheGap");
        Assert.True(created.Applied, created.Message);

        var npcsDir = Path.Combine(mod.ModFolder, SourceRepository.RootFor(SourceEditFixture.PluginName), "Npcs");
        var names = Directory.GetFiles(npcsDir)
            .Select(f => Path.GetFileName(f) ?? throw new InvalidOperationException("Expected a file path to have a file name."))
            .Where(n => !string.Equals(n, "GroupRecordData.json", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Equal(2, names.Count);
        Assert.Contains(names, n => n.StartsWith("UntouchedNpc", StringComparison.Ordinal));
        Assert.Contains(names, n => n.StartsWith("AfterTheGap", StringComparison.Ordinal));
    }

    [Fact]
    public void CreateRecord_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.NotNull(result.NewFormKey);
        Assert.Null(mod.CommittedDocument(result.NewFormKey, "npc_", "BrandNewNpc"));
    }

    [Fact]
    public void CreateRecord_AllocatesAboveAnIdOnlyTheCommittedTreeStillHolds()
    {
        using var mod = SourceEditFixture.Tracked();
        var headOnly = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "HeadOnlySeed", "F00000:Fixture.esp");
        Assert.True(headOnly.Applied, headOnly.Message);
        Assert.NotNull(headOnly.NewFormKey);
        var headOnlyFormKey = headOnly.NewFormKey;
        Commit(mod);
        Assert.Empty(mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, headOnlyFormKey)]).Refused);
        Assert.Null(mod.Document(headOnlyFormKey));

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AllocatedAfter");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var resultFormKey = result.NewFormKey;
        Assert.True(LocalId(resultFormKey) > LocalId(headOnlyFormKey),
            $"expected an ID above {headOnlyFormKey}, got {resultFormKey} — the allocator must " +
            "consult the committed tree, not just the working one.");
    }

    private static void Commit(SourceEditFixture mod)
    {
        var git = Path.Combine(mod.ModFolder, ".git");
        GitProbe.Run(git, mod.ModFolder, "add", "-A");
        GitProbe.Run(git, mod.ModFolder, "commit", "-q", "-m", "seed");
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':', StringComparison.Ordinal)], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    [Fact]
    public void CreateRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Run \"Modbench: Track Mod…\"", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForAnUnknownRecordType()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "not-a-real-type", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForTheHeaderPseudoType()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "header", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_WithARequestedFormKey_Refuses_WhenItBelongsToADifferentPlugin()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void CreateRecord_WithARequestedFormKey_Refuses_WhenItCollides()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    [Fact]
    public void CreateRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = SourceEditFixture.Tracked();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheTop", "FFFFFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
        Assert.Contains(BothRemedies, result.Message, StringComparison.Ordinal);
    }

    private const string BothRemedies = "Clear the light flag in the header, or change a record's FormID.";

    [Fact]
    public void CreateRecord_OnALightEspPlugin_Refuses_WhenTheEslRangeIsExhausted()
    {
        using var mod = SourceEditFixture.TrackedLight();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OnALightEspPlugin_WhenEslRangeExhausted_NamesBothRemedies()
    {
        using var mod = SourceEditFixture.TrackedLight();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.Contains(BothRemedies, result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_OnALightEspPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneBelowTheEslCap", "000FFE:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esp", result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_OnAPlainEslPlugin_Refuses_WhenTheEslRangeIsExhausted()
    {
        using var mod = SourceEditFixture.TrackedLight("Fixture.esl");
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esl");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OnAPlainEslPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight("Fixture.esl");
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneBelowTheEslCap", "000FFE:Fixture.esl");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esl", result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_TypedTarget_OnALightPlugin_Refuses_AboveTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LightPluginFormIdOutOfRange, result.Refusal);
    }

    [Fact]
    public void CreateRecord_TypedTarget_OnAnUnflaggedPlugin_AtTheSameId_Succeeds()
    {
        using var mod = SourceEditFixture.Tracked();
        const string requested = "001000:Fixture.esp";

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_WithAFreeRequestedFormKey_UsesItExactly()
    {
        using var mod = SourceEditFixture.Tracked();
        const string requested = "900000:Fixture.esp";

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }
}
