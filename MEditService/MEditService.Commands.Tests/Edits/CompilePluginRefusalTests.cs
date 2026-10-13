using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginRefusalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private CompilePluginHandler CompileService() =>
        _mod.CompileService();

    [Fact]
    public async Task Compile_WithTwoDocumentsClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        TreeTampering.Duplicate(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(_mod.Npc.ToString(), refused.Message);
    }

    [Fact]
    public async Task Compile_WithADocumentItCannotRead_RefusesNamingTheFile()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        using var held = TreeTampering.HoldOpen(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithUnparsableSourceFile_RefusesNamingTheFile()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        _mod.Overwrite(_mod.NpcIdentity, "{ not valid json");

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceDoesNotParse, refused.Refusal);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), refused.Message, StringComparison.Ordinal);
        Assert.Empty(answer.Landed);
    }

    [Fact]
    public async Task Compile_WithAFieldRenamedToOneTheCodecDoesNotRead_RefusesNamingTheFileAndTheField()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        var npcSourceText = _mod.Document(_mod.Npc.ToString()).Require().Body;
        Assert.Contains("\"Race\"", npcSourceText);
        _mod.Overwrite(_mod.NpcIdentity, npcSourceText.Replace("\"Race\"", "\"RaceOld\"", StringComparison.Ordinal));

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains($"{Path.GetRelativePath(_mod.ModFolder, file)}: RaceOld", refused.Message, StringComparison.Ordinal);
        Assert.Empty(answer.Landed);
    }

    [Fact]
    public async Task Compile_WithTwoBrokenFiles_RefusesNamingBothAndTheFieldAtFaultInEach()
    {
        var otherIdentity = new RecordIdentity(_mod.OtherNpc.ToString(), CompileFixture.NpcRecordType, CompileFixture.OtherNpcEditorId);
        var npcFile = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        var otherFile = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, otherIdentity);
        _mod.Overwrite(_mod.NpcIdentity, _mod.Document(_mod.Npc.ToString()).Require().Body.Replace("\"Race\"", "\"RaceOld\"", StringComparison.Ordinal));
        _mod.Overwrite(otherIdentity, _mod.Document(_mod.OtherNpc.ToString()).Require().Body.Replace("\"EditorID\"", "\"EditorTypo\"", StringComparison.Ordinal));

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains($"{Path.GetRelativePath(_mod.ModFolder, npcFile)}: RaceOld", refused.Message, StringComparison.Ordinal);
        Assert.True(refused.Message.Contains($"{Path.GetRelativePath(_mod.ModFolder, otherFile)}: EditorTypo", StringComparison.Ordinal), refused.Message);
    }

    [Fact]
    public async Task Compile_WithAFieldMisspelledInABlockLevelDocument_RefusesNamingTheFileAndTheField()
    {
        _mod.Write(new Cell(FormKey.Factory($"000900:{CompileFixture.PluginName}"), Fallout4Release.Fallout4)
        {
            EditorID = "Room",
            Flags = Cell.Flag.IsInteriorCell,
        }, "cell");
        var levels = Directory.GetFiles(_mod.ModFolder, "GroupRecordData.json", SearchOption.AllDirectories).Where(file => new FileInfo(file).Length > 2).ToArray();
        var level = Path.GetRelativePath(_mod.ModFolder, levels[0]);
        File.WriteAllText(levels[0], File.ReadAllText(levels[0]).Replace("BlockNumber", "BlockNumbr", StringComparison.Ordinal));

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains($"{level}: BlockNumbr", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithAValueOfTheWrongTypeInABlockLevelDocument_RefusesNamingTheFileAndTheField_AndNoDecompile()
    {
        _mod.Write(new Cell(FormKey.Factory($"000900:{CompileFixture.PluginName}"), Fallout4Release.Fallout4)
        {
            EditorID = "Room",
            Flags = Cell.Flag.IsInteriorCell,
        }, "cell");
        var levels = Directory.GetFiles(_mod.ModFolder, "GroupRecordData.json", SearchOption.AllDirectories).Where(file => new FileInfo(file).Length > 2).ToArray();
        var level = Path.GetRelativePath(_mod.ModFolder, levels[0]);
        File.WriteAllText(levels[0], System.Text.RegularExpressions.Regex.Replace(File.ReadAllText(levels[0]), "\"BlockNumber\": \\d+", "\"BlockNumber\": \"text\""));

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceDoesNotParse, refused.Refusal);
        Assert.Contains($"{level}: BlockNumber", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Decompile", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithAFileReformattedAndReordered_CompilesLikeAnyOther()
    {
        var body = _mod.Document(_mod.Npc.ToString()).Require().Body;
        var members = JsonNode.Parse(body)?.AsObject() ?? throw new InvalidOperationException("Expected a document.");
        var editorId = members["EditorID"];
        _ = members.Remove("EditorID");
        members["EditorID"] = editorId;
        _mod.Overwrite(_mod.NpcIdentity, members.ToJsonString(new JsonSerializerOptions { WriteIndented = true }).Replace("\n", "\n\n", StringComparison.Ordinal));

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        Assert.Empty(answer.Refused);
        Assert.Single(answer.Landed);
    }
}
