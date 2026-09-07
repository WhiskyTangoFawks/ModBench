using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

/// <summary>Asserted against a real git repo through the real CLI, because "visible in the Source
/// Control panel" is a claim about what <c>git status</c> says (ADR-0041).</summary>
public sealed class RecordEditServiceTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ---- an EditorID edit is a rename as well as a content change ----

    [Fact]
    public void EditingEditorId_MovesTheSourceFileToItsNewName()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId);
        Assert.True(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));

        var result = _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));
        // Resolved after the rename: RelativeSourcePath answers where the record is right now.
        var newRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", "RenamedNpc");
        var moved = Path.Combine(_mod.ModFolder, newRelative);
        Assert.True(File.Exists(moved));
        Assert.DoesNotContain("[", Path.GetFileName(newRelative), StringComparison.Ordinal);
        Assert.Contains("\"EditorID\": \"RenamedNpc\"", File.ReadAllText(moved), StringComparison.Ordinal);
        Assert.Equal("RenamedNpc", _mod.Document(_mod.Npc.ToString())!.EditorId);
    }

    [Fact]
    public void EditingEditorId_ShowsAsARenameOnceStaged_NotADeleteAndAdd()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId)
            .Replace('\\', '/');

        Assert.True(_mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\"")).Applied);

        // Resolved after the rename: resolving both paths up front would have them collide on the
        // same still-old file and make the assertions below pass without checking anything.
        var newRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", "RenamedNpc").Replace('\\', '/');

        // The unstaged reality, asserted rather than glossed, so a future reader does not mistake it
        // for a bug in the write path.
        Assert.Contains($"D {oldRelative}", _mod.GitStatus());

        // Measured similarity on real git runs R099 for a container document down to R050 for the
        // minimal one — exactly git's default 50% threshold, so a smaller shape puts detection at risk.
        var git = Path.Combine(_mod.ModFolder, ".git");
        GitCli.Run(git, _mod.ModFolder, "add", "-A");
        var staged = GitCli.Run(git, _mod.ModFolder, "diff", "--cached", "-M", "--name-status")
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
        // Track has just committed the complete pristine state, so anything git reports afterwards
        // is this edit's own doing — the positive control for every status assertion below.
        Assert.Empty(_mod.GitStatus());

        var result = _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
    }

    [Fact]
    public async Task EditField_WritesTheNewValueIntoTheSourceFile_AsRealCodecText()
    {
        _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        // Re-parsed through the codec rather than string-matched: the file has to remain a document
        // the source can round-trip, not merely text that happens to contain the right number.
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var reparsed = await codec.DeserializeAsync(_mod.NpcSourceFile, GameRelease.Fallout4, "npc_");
        Assert.Equal(_mod.Npc, reparsed.FormKey);
        Assert.Equal(0.75f, ((Mutagen.Bethesda.Fallout4.INpcGetter)reparsed).HeightMax);
    }

    [Fact]
    public void EditField_ChangesOnlyTheEditedRecordsFile()
    {
        _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var status = _mod.GitStatus();
        Assert.Single(status);
        Assert.DoesNotContain(
            _mod.RelativeSourcePath(_mod.OtherNpc, "npc_", SourceEditFixture.OtherNpcEditorId).Replace('\\', '/'),
            status[0], StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_LeavesTheCommittedTextAsItWas_UntilItIsCommitted()
    {
        _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId);
        Assert.Contains("0.75", File.ReadAllText(Path.Combine(_mod.ModFolder, relative)), StringComparison.Ordinal);
        Assert.DoesNotContain("0.75", _mod.GitShowHead(relative), StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_TwiceOnTheSameRecord_BuildsOnTheFirstEditRatherThanTheCommittedText()
    {
        _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMin", Json("0.5"));

        // The second edit reads what the first wrote, not the committed baseline, so both values are
        // in the file the second edit produced.
        var text = File.ReadAllText(Path.Combine(
            _mod.ModFolder, _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId)));
        Assert.Contains("0.75", text, StringComparison.Ordinal);
        Assert.Contains("0.5", text, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_WithAnUnknownFieldName_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_ForAFormKeyThePluginDoesNotHold_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = _mod.Edits.Set(_mod.Plugin, "ABCDEF:NotHere.esp", "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // ---- parse status is the codec's, asked at edit time (ADR-0046 invariant 7) ----

    [Fact]
    public void EditField_OfADocumentTheCodecCannotRead_RefusesWithTheCodecsOwnMessage()
    {
        // Hand-edited into a document the codec cannot build a record from: text where the record's
        // own class carries a number.
        Corrupt("\"MajorRecordFlagsRaw\": \"notanumber\",\n  \"EditorID\"");

        var result = _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("cannot be read", result.Message, StringComparison.Ordinal);
    }

    // JsonDocument tolerates a duplicate member and JsonNode does not, so this document never
    // reaches the codec at all.
    [Fact]
    public void EditField_OfADocumentWithADuplicateMember_RefusesRatherThanThrowing()
    {
        Corrupt("\"EditorID\": \"Twice\",\n  \"EditorID\"");

        var result = _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
    }

    private void Corrupt(string replacingEditorIdMember) =>
        File.WriteAllText(
            _mod.NpcSourceFile,
            File.ReadAllText(_mod.NpcSourceFile)
                .Replace("\"EditorID\"", replacingEditorIdMember, StringComparison.Ordinal));

    [Fact]
    public void EditField_OfADocumentThatIsNotJson_RefusesRatherThanThrowing()
    {
        File.WriteAllText(_mod.NpcSourceFile, "this is not a document");

        var result = _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }

    [Fact]
    public void EditField_WhenTheRecordsFileHasGoneFromTheTree_Refuses()
    {
        File.Delete(_mod.NpcSourceFile);

        var result = _mod.Edits.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(_mod.Npc.ToString(), result.Message, StringComparison.Ordinal);
    }
}
