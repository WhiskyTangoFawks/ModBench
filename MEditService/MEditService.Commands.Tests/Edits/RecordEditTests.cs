using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class RecordEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingEditorId_LandsTheNewNameOnTheRecord()
    {
        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        var document = _mod.Document(_mod.Npc.ToString()).Require();
        Assert.Equal("RenamedNpc", document.EditorId);
        Assert.Contains("\"EditorID\": \"RenamedNpc\"", document.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_OfARecordFileRenamedByHandToANameWithNoFormKey_MovesItToTheLayoutsName()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        var byHand = Path.Combine(Path.GetDirectoryName(file) ?? string.Empty, "ByHand.json");
        File.Move(file, byHand);

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.True(File.Exists(file));
        Assert.False(File.Exists(byHand));
    }

    [Fact]
    public void EditField_OnATrackedPlugin_LeavesTheRecordChangedSinceTheLastCommit()
    {
        Assert.Empty(_mod.ChangedFormKeys());

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_mod.Npc.ToString()], _mod.ChangedFormKeys());
    }

    [Fact]
    public void EditField_WritesTheNewValueIntoTheSourceFile_AsRealCodecText()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var reparsed = codec.DeserializeFromBytes(
            Encoding.UTF8.GetBytes(_mod.Document(_mod.Npc.ToString()).Require().Body), GameRelease.Fallout4, "npc_");
        Assert.Equal(_mod.Npc, reparsed.FormKey);
        Assert.Equal(0.75f, ((Mutagen.Bethesda.Fallout4.INpcGetter)reparsed).HeightMax);
    }

    [Fact]
    public void EditField_ChangesOnlyTheEditedRecord()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.DoesNotContain(_mod.OtherNpc.ToString(), Assert.Single(_mod.ChangedFormKeys()), StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_LeavesTheEditUncommitted_UntilItIsCommitted()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.Contains("0.75", _mod.Document(_mod.Npc.ToString()).Require().Body, StringComparison.Ordinal);
        Assert.Equal([_mod.Npc.ToString()], _mod.ChangedFormKeys());
    }

    [Fact]
    public void EditField_TwiceOnTheSameRecord_BuildsOnTheFirstEditRatherThanTheCommittedText()
    {
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMin", Json("0.5"));

        var text = _mod.Document(_mod.Npc.ToString()).Require().Body;
        Assert.Contains("0.75", text, StringComparison.Ordinal);
        Assert.Contains("0.5", text, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_WithAnUnknownFieldName_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Empty(_mod.ChangedFormKeys());
    }

    [Fact]
    public void EditField_ForAFormKeyThePluginDoesNotHold_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = _mod.EditHandler.Set(_mod.Plugin, "ABCDEF:NotHere.esp", "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Empty(_mod.ChangedFormKeys());
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
        Assert.Equal(corrupted, _mod.Document(_mod.Npc.ToString()).Require().Body);
    }

    [Fact]
    public void EditField_OfADocumentWithADuplicateMember_RefusesRatherThanThrowing()
    {
        var corrupted = Corrupt("\"EditorID\": \"Twice\",\n  \"EditorID\"");

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(corrupted, _mod.Document(_mod.Npc.ToString()).Require().Body);
    }

    private string Corrupt(string replacingEditorIdMember)
    {
        var corrupted = _mod.Document(_mod.Npc.ToString()).Require().Body
            .Replace("\"EditorID\"", replacingEditorIdMember, StringComparison.Ordinal);
        _mod.Overwrite(_mod.NpcIdentity, corrupted);
        return corrupted;
    }

    [Fact]
    public void EditField_OfADocumentThatIsNotJson_RefusesAsUnreadable_AndWritesNothing()
    {
        const string garbage = "this is not a document";
        _mod.Overwrite(_mod.NpcIdentity, garbage);
        var unreadableBefore = Unreadable();

        var (result, changes) = _mod.EditChangesHandler.Changes(
            _mod.Plugin, _mod.Npc.ToString(), Envelopes.SetAt(Json("0.75"), Envelopes.Member("HeightMax")), garbage);

        Assert.False(result.Applied);
        Assert.Empty(changes.Documents);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains($"'{garbage}' is an invalid JSON literal", result.Message, StringComparison.Ordinal);
        Assert.NotNull(unreadableBefore);
        Assert.Equal(unreadableBefore, Unreadable());
    }

    private string Unreadable() => Assert.Throws<UnreadableSourceDocumentException>(
        () => _mod.Repository.Require().Get(
            _mod.Plugin, _mod.Npc.ToString(), SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4))).Message;

    [Fact]
    public void EditEditorId_OfADocumentThatIsNotJson_RefusesAsUnreadable_AndRenamesNothing()
    {
        _mod.Overwrite(_mod.NpcIdentity, "this is not a document");

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\""));

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.NotNull(Unreadable());
    }

    [Fact]
    public void EditField_WhenTheRecordHasGoneFromTheTree_Refuses()
    {
        _mod.Remove(_mod.NpcIdentity);

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(_mod.Npc.ToString(), result.Message, StringComparison.Ordinal);
    }
}
