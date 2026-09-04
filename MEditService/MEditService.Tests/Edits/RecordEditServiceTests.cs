using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

/// <summary>Asserted against a real git repo through the real CLI, because "visible in the Source
/// Control panel" is a claim about what <c>git status</c> says (ADR-0041).</summary>
public sealed class RecordEditServiceTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ---- an editor_id edit is a rename as well as a content change ----

    [Fact]
    public void EditingEditorId_MovesTheSourceFileToItsNewName()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId);
        var groupDirectory = Path.GetDirectoryName(Path.Combine(_mod.ModFolder, oldRelative))!;
        var carrier = SourceChildOrder.CarrierFor(groupDirectory, parentIsRecord: false);
        var orderBefore = SourceChildOrder.ListAt(carrier, "Npcs");
        Assert.True(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "editor_id", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));
        // Resolved after the rename: RelativeSourcePath answers where the record is right now. A rename
        // must not disturb the record's position among its siblings, which lives in the parent's ordered
        // child list keyed by FormKey.
        var newRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", "RenamedNpc");
        var moved = Path.Combine(_mod.ModFolder, newRelative);
        Assert.True(File.Exists(moved));
        Assert.Equal(orderBefore, SourceChildOrder.ListAt(carrier, "Npcs"));
        Assert.DoesNotContain("[", Path.GetFileName(newRelative), StringComparison.Ordinal);
        Assert.Contains("\"EditorID\": \"RenamedNpc\"", File.ReadAllText(moved), StringComparison.Ordinal);
        Assert.Equal("RenamedNpc", _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.EditorId);
    }

    [Fact]
    public void EditingEditorId_ShowsAsARenameOnceStaged_NotADeleteAndAdd()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId)
            .Replace('\\', '/');

        Assert.True(Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "editor_id", Json("\"RenamedNpc\"")).Applied);

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

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
    }

    [Fact]
    public async Task EditField_WritesTheNewValueIntoTheSourceFile_AsRealCodecText()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        // Re-parsed through the codec rather than string-matched: the file has to remain a document
        // the source can round-trip, not merely text that happens to contain the right number.
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var reparsed = await codec.DeserializeAsync(_mod.NpcSourceFile, GameRelease.Fallout4, "npc_");
        Assert.Equal(_mod.Npc, reparsed.FormKey);

        // ...and the value is read back through the same typed extraction the record editor renders
        // from, not by reaching into the Mutagen object a second way.
        var field = _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!
            .Fields.Single(f => f.Metadata.Name == "height_max");
        Assert.Equal(0.75f, Assert.IsType<float>(field.Value));
    }

    [Fact]
    public void EditField_ChangesOnlyTheEditedRecordsFile()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        var status = _mod.GitStatus();
        Assert.Single(status);
        Assert.DoesNotContain(_mod.RelativeSourcePath(_mod.OtherNpc, "npc_", TrackedModFixture.OtherNpcEditorId).Replace('\\', '/'), status[0], StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_MakesTheReadModelServeTheNewValueAtEffective_AndTheCommittedOneAtHead()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        // The file write and the index update are one gesture: a write path that produced dirt on
        // disk but left the editor showing the old value, or vice versa, is half a write path.
        var index = _mod.Mirror.Index!;
        var effective = index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!;
        Assert.Contains("0.75", effective.Body!, StringComparison.Ordinal);

        var head = index.At(RecordRef.Head).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!;
        Assert.DoesNotContain("0.75", head.Body!, StringComparison.Ordinal);
        Assert.Equal(_mod.GitShowHead(_mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId)), head.Body);
    }

    [Fact]
    public void EditField_TwiceOnTheSameRecord_KeepsTheCommittedStateAsTheBaseline()
    {
        var service = Service();
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.5"));

        // The second edit must not re-baseline against the first: Head is what the last commit
        // holds, not "the value before the most recent keystroke".
        var index = _mod.Mirror.Index!;
        Assert.Contains("0.5", index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!, StringComparison.Ordinal);
        Assert.Equal(
            _mod.GitShowHead(_mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId)),
            index.At(RecordRef.Head).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body);
    }

    [Fact]
    public void EditField_WithAnUnknownFieldName_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_ForAFormKeyThePluginDoesNotHold_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = Service().EditField(_mod.Plugin, "ABCDEF:NotHere.esp", "height_max", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // _filter is a one-shot snapshot of whatever matched when SetFilter ran, so an edit that changes
    // the value a predicate reads can flip membership, and only the edit path can re-materialize it.
    [Fact]
    public void EditField_MakesTheRecordNewlyMatchAnActiveFilter_FilteredListingIncludesIt()
    {
        _mod.Mirror.SetFilter("SELECT form_key FROM npc_ WHERE height_max = 0.75");
        Assert.Equal(0, _mod.Mirror.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        var result = _mod.Mirror.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
        Assert.Equal(1, result.Total);
        Assert.Equal(_mod.Npc.ToString(), result.Items[0].FormKey);
    }
}
