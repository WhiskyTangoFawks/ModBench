using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class EditRecordHandlerTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingEditorId_MovesTheSourceFileToItsNewName()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId);
        Assert.True(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));
        var newRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", "RenamedNpc");
        var moved = Path.Combine(_mod.ModFolder, newRelative);
        Assert.True(File.Exists(moved));
        Assert.DoesNotContain("[", Path.GetFileName(newRelative), StringComparison.Ordinal);
        Assert.Contains("\"EditorID\": \"RenamedNpc\"", File.ReadAllText(moved), StringComparison.Ordinal);
        var document = _mod.Document(_mod.Npc.ToString());
        Assert.NotNull(document);
        Assert.Equal("RenamedNpc", document.EditorId);
    }

    [Fact]
    public void EditingEditorId_ShowsAsARenameOnceStaged_NotADeleteAndAdd()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId)
            .Replace('\\', '/');

        Assert.True(_mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\"")).Applied);

        var newRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", "RenamedNpc").Replace('\\', '/');

        Assert.Contains($"D {oldRelative}", _mod.GitStatus());

        var git = Path.Combine(_mod.ModFolder, ".git");
        GitProbe.Run(git, _mod.ModFolder, "add", "-A");
        var staged = GitProbe.Run(git, _mod.ModFolder, "diff", "--cached", "-M", "--name-status")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

        var rename = Assert.Single(staged, l => l.StartsWith('R'));
        Assert.Contains(oldRelative, rename, StringComparison.Ordinal);
        Assert.Contains(newRelative, rename, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_OnATrackedPlugin_LeavesTheRecordsSourceFileDirtyInTheSourceControlPanel()
    {
        Assert.Empty(_mod.GitStatus());

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
    }

    [Fact]
    public void EditField_WritesTheNewValueIntoTheSourceFile_AsRealCodecText()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var reparsed = codec.DeserializeFile(_mod.NpcSourceFile, GameRelease.Fallout4, "npc_");
        Assert.Equal(_mod.Npc, reparsed.FormKey);
        Assert.Equal(0.75f, ((Mutagen.Bethesda.Fallout4.INpcGetter)reparsed).HeightMax);
    }

    [Fact]
    public void EditField_ChangesOnlyTheEditedRecordsFile()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var status = _mod.GitStatus();
        Assert.Single(status);
        Assert.DoesNotContain(
            _mod.RelativeSourcePath(_mod.OtherNpc, "npc_", SourceEditFixture.OtherNpcEditorId).Replace('\\', '/'),
            status[0], StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_LeavesTheCommittedTextAsItWas_UntilItIsCommitted()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId);
        Assert.Contains("0.75", File.ReadAllText(Path.Combine(_mod.ModFolder, relative)), StringComparison.Ordinal);
        Assert.DoesNotContain("0.75", _mod.GitShowHead(relative), StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_TwiceOnTheSameRecord_BuildsOnTheFirstEditRatherThanTheCommittedText()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMin", Json("0.5"));

        var text = File.ReadAllText(Path.Combine(
            _mod.ModFolder, _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId)));
        Assert.Contains("0.75", text, StringComparison.Ordinal);
        Assert.Contains("0.5", text, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_WithAnUnknownFieldName_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_ForAFormKeyThePluginDoesNotHold_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = _mod.EditHandler.Set(_mod.Plugin, "ABCDEF:NotHere.esp", "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_OfADocumentTheCodecCannotRead_RefusesWithTheCodecsOwnMessage()
    {
        var corrupted = Corrupt("\"MajorRecordFlagsRaw\": \"notanumber\",\n  \"EditorID\"");

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(
            "Unable to cast object of type 'System.String' to type 'System.Int64'",
            result.Message, StringComparison.Ordinal);
        Assert.Equal(corrupted, File.ReadAllText(_mod.NpcSourceFile));
    }

    [Fact]
    public void EditField_OfADocumentWithADuplicateMember_RefusesRatherThanThrowing()
    {
        var corrupted = Corrupt("\"EditorID\": \"Twice\",\n  \"EditorID\"");

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(corrupted, File.ReadAllText(_mod.NpcSourceFile));
    }

    private string Corrupt(string replacingEditorIdMember)
    {
        var corrupted = File.ReadAllText(_mod.NpcSourceFile)
            .Replace("\"EditorID\"", replacingEditorIdMember, StringComparison.Ordinal);
        File.WriteAllText(_mod.NpcSourceFile, corrupted);
        return corrupted;
    }

    [Fact]
    public void EditField_OfADocumentThatIsNotJson_RefusesAsUnreadable_AndWritesNothing()
    {
        const string garbage = "this is not a document";
        File.WriteAllText(_mod.NpcSourceFile, garbage);

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains($"'{garbage}' is an invalid JSON literal", result.Message, StringComparison.Ordinal);
        Assert.Equal(garbage, File.ReadAllText(_mod.NpcSourceFile));
    }

    [Fact]
    public void EditEditorId_OfADocumentThatIsNotJson_RefusesAsUnreadable_AndRenamesNothing()
    {
        File.WriteAllText(_mod.NpcSourceFile, "this is not a document");

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\""));

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.True(File.Exists(_mod.NpcSourceFile));
    }

    [Fact]
    public void EditField_WhenTheRecordsFileHasGoneFromTheTree_Refuses()
    {
        File.Delete(_mod.NpcSourceFile);

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(_mod.Npc.ToString(), result.Message, StringComparison.Ordinal);
    }
}
