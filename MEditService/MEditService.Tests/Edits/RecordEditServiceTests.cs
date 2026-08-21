using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

/// <summary>
/// #415 AC1: editing a field on a tracked plugin produces working-tree dirt on that record's source
/// file — the single write path (ADR-0041). Asserted against a real git repo through the real CLI,
/// because "visible and diffable in the native Source Control panel" is a claim about what
/// <c>git status</c> says, and nothing else can answer it.
/// </summary>
public sealed class RecordEditServiceTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_OnATrackedPlugin_LeavesTheRecordsSourceFileDirtyInTheSourceControlPanel()
    {
        // Track has just committed the complete pristine state, so anything git reports afterwards
        // is this edit's own doing — the positive control for every status assertion below.
        Assert.Empty(_mod.GitStatus());

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        var relative = TrackedModFixture.RelativeSourcePath(_mod.Npc, "npc_").Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
    }

    [Fact]
    public async Task EditField_WritesTheNewValueIntoTheSourceFile_AsRealCodecText()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        // Re-parsed through the codec rather than string-matched: the file has to remain a document
        // the source can round-trip, not merely text that happens to contain the right number.
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var reparsed = await codec.DeserializeAsync(_mod.NpcSourceFile, GameRelease.Fallout4);
        Assert.Equal(_mod.Npc, reparsed.FormKey);

        // ...and the value is read back through the same typed extraction the record editor renders
        // from, not by reaching into the Mutagen object a second way.
        var field = _mod.Sessions.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!
            .Fields.Single(f => f.Metadata.Name == "height_max");
        Assert.Equal(0.75f, Assert.IsType<float>(field.Value));
    }

    [Fact]
    public void EditField_ChangesOnlyTheEditedRecordsFile()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        var status = _mod.GitStatus();
        Assert.Single(status);
        Assert.DoesNotContain(TrackedModFixture.RelativeSourcePath(_mod.OtherNpc, "npc_").Replace('\\', '/'), status[0], StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_MakesTheReadModelServeTheNewValueAtEffective_AndTheCommittedOneAtHead()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        // The file write and the index update are one gesture: a write path that produced dirt on
        // disk but left the editor showing the old value, or vice versa, is half a write path.
        var index = _mod.Sessions.Index!;
        var effective = index.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!;
        Assert.Contains("0.75", effective.Body!, StringComparison.Ordinal);

        var head = index.At(RecordRef.Head).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!;
        Assert.DoesNotContain("0.75", head.Body!, StringComparison.Ordinal);
        Assert.Equal(_mod.GitShowHead(TrackedModFixture.RelativeSourcePath(_mod.Npc, "npc_")), head.Body);
    }

    [Fact]
    public void EditField_TwiceOnTheSameRecord_KeepsTheCommittedStateAsTheBaseline()
    {
        var service = Service();
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.5"));

        // The second edit must not re-baseline against the first: Head is what the last commit
        // holds, not "the value before the most recent keystroke".
        var index = _mod.Sessions.Index!;
        Assert.Contains("0.5", index.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!, StringComparison.Ordinal);
        Assert.Equal(
            _mod.GitShowHead(TrackedModFixture.RelativeSourcePath(_mod.Npc, "npc_")),
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

    // #422: _filter is a one-shot snapshot of whatever matched when SetFilter ran — a field edit that
    // changes the value a filter predicate reads can flip that record's membership, and nothing but
    // the edit path itself is positioned to re-materialize it afterward.
    [Fact]
    public void EditField_MakesTheRecordNewlyMatchAnActiveFilter_FilteredListingIncludesIt()
    {
        _mod.Sessions.SetFilter("SELECT form_key FROM npc_ WHERE height_max = 0.75");
        Assert.Equal(0, _mod.Sessions.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        var result = _mod.Sessions.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
        Assert.Equal(1, result.Total);
        Assert.Equal(_mod.Npc.ToString(), result.Items[0].FormKey);
    }
}
