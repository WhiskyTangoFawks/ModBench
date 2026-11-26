using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class RecordEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.CompiledPlugin();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void EditField_WithAnUnknownFieldName_RefusesAsFieldNotFound_AndChangesNoRecord()
    {
        var before = SourceModTree.Records(_mod.ModFolder, _mod.Plugin);

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal(before, SourceModTree.Records(_mod.ModFolder, _mod.Plugin));
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
    public void EditField_OfADocumentThatIsNotJson_RefusesAsParseFailed_NamingTheJsonError_AndLeavesTheUnreadableRecordAsItWas()
    {
        const string garbage = "this is not a document";
        _mod.Overwrite(_mod.NpcIdentity, garbage);
        var unreadableBefore = Unreadable();

        var (result, _) = _mod.EditChangesHandler.Changes(
            _mod.Plugin, _mod.Npc.ToString(), Envelopes.SetAt(Json("0.75"), Envelopes.Member("HeightMax")), copiesWithNoPluginSource: Envelopes.NoCopies);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains($"'{garbage}' is an invalid JSON literal", result.Message, StringComparison.Ordinal);
        Assert.NotNull(unreadableBefore);
        Assert.Equal(unreadableBefore, Unreadable());
    }

    [Fact]
    public void EditEditorId_OfADocumentThatIsNotJson_RefusesAsParseFailed_AndRenamesNothing()
    {
        _mod.Overwrite(_mod.NpcIdentity, "this is not a document");
        var unreadableBefore = Unreadable();

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\""));

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(unreadableBefore, Unreadable());
    }

    private string Unreadable() =>
        Assert.IsType<SourceFailure.Unreadable>(_mod.Repository.Require().RecordByFormKey(_mod.Plugin, _mod.Npc.ToString()).Stopped()).Reason;
}
