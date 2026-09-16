using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>ADR-0014: the write side never pushes, so what the Index serves after a write is what a
/// projection of the changed tree made of it. Read here, never in the write suites.</summary>
public sealed class IndexAfterAWriteTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private ProjectingEditService Service() => ProjectingEditService.Over(_mod.Index, _mod.Holder);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static string RequireNewFormKey(RecordEditResult result) =>
        result.NewFormKey ?? throw new InvalidOperationException("Expected a successful edit to set NewFormKey.");

    [Fact]
    public void AnEditorIdEdit_ProjectsTheNewNameOntoTheRecordsRow()
    {
        Assert.True(Service().Set(_mod.Plugin, _mod.Npc.ToString(), "EditorID", Json("\"RenamedNpc\"")).Applied);

        var document = _mod.Index.Projected().GetDocument(_mod.Npc.ToString(), _mod.Plugin).Require();
        Assert.Equal("RenamedNpc", document.EditorId);
    }

    [Fact]
    public void AFieldEdit_IsReadableThroughTheSameTypedExtractionTheRecordEditorRendersFrom()
    {
        Assert.True(Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75")).Applied);

        var document = _mod.Index.Projected().GetDocument(_mod.Npc.ToString(), _mod.Plugin).Require();
        var field = document.Fields.Single(f => f.Metadata.Name == "HeightMax");
        Assert.Equal(0.75f, Assert.IsType<JsonElement>(field.Value).GetSingle());
    }

    [Fact]
    public void AFieldEdit_ServesTheNewValueAtEffective_AndTheCommittedOneAtHead()
    {
        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        // The file write and the projection are two events (ADR-0014), and both have to have landed:
        // dirt on disk with the editor showing the old value is half a write path.
        var index = _mod.Index.RequireReads();
        var effective = index.GetDocument(_mod.Npc.ToString(), _mod.Plugin).Require();
        Assert.Contains("0.75", effective.Body.Require(), StringComparison.Ordinal);

        var head = index.HeadDocument(_mod.Npc.ToString(), _mod.Plugin).Require();
        Assert.DoesNotContain("0.75", head.Body.Require(), StringComparison.Ordinal);
        Assert.Equal(
            _mod.GitShowHead(_mod.RelativeSourcePath(_mod.Npc, "npc_", IndexedModFixture.NpcEditorId)), head.Body);
    }

    [Fact]
    public void TwoEditsOnOneRecord_KeepTheCommittedStateAsTheHeadBaseline()
    {
        var service = Service();
        service.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        service.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.5"));

        // The second edit must not re-baseline against the first: Head is what the last commit
        // holds, not "the value before the most recent keystroke".
        var index = _mod.Index.RequireReads();
        var effective = index.GetDocument(_mod.Npc.ToString(), _mod.Plugin).Require();
        Assert.Contains("0.5", effective.Body.Require(), StringComparison.Ordinal);
        var head = index.HeadDocument(_mod.Npc.ToString(), _mod.Plugin).Require();
        Assert.Equal(
            _mod.GitShowHead(_mod.RelativeSourcePath(_mod.Npc, "npc_", IndexedModFixture.NpcEditorId)),
            head.Body);
    }

    // _filter is a one-shot snapshot of whatever matched when SetFilter ran, so an edit that changes
    // the value a predicate reads can flip membership, and only the edit path can re-materialize it.
    [Fact]
    public void AnEditThatMakesARecordMatchAnActiveFilter_PutsItInTheFilteredListing()
    {
        _mod.Index.SetFilter("SELECT form_key FROM npc_ WHERE HeightMax = 0.75");
        Assert.Equal(
            0, _mod.Index.Projected().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var result = _mod.Index.Projected().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
        Assert.Equal(1, result.Total);
        Assert.Equal(_mod.Npc.ToString(), result.Items[0].FormKey);
    }

    [Fact]
    public void ACreatedRecord_IsReadableAtEffective_AsAWorkingTreeAddition()
    {
        var result = Service().CreateRecord(_mod.Plugin, "npc_", "BrandNewNpc");

        Assert.True(result.Applied, result.Message);
        var newFormKey = RequireNewFormKey(result);
        var document = _mod.Index.Projected().GetDocument(newFormKey, _mod.Plugin).Require();
        Assert.Equal("BrandNewNpc", document.EditorId);
        Assert.True(_mod.Index.Projected().StackEntry(newFormKey, _mod.Plugin).Require().HasWorkingTreeChange);
    }

    // _filter never evaluated a brand-new row against its SQL, so it stays hidden until the create
    // path re-materializes the matching set.
    [Fact]
    public void ACreatedRecord_AppearsInAnActiveFilteredListing()
    {
        _mod.Index.SetFilter("SELECT form_key FROM npc_");
        var before = _mod.Index.Projected().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 50, Offset: 0)).Total;

        var result = Service().CreateRecord(_mod.Plugin, "npc_", "BrandNewNpc");

        Assert.True(result.Applied, result.Message);
        var after = _mod.Index.Projected().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 50, Offset: 0));
        Assert.Equal(before + 1, after.Total);
        Assert.Contains(after.Items, i => i.FormKey == result.NewFormKey);
    }

    [Fact]
    public void AnEditToANeverCommittedRecord_ReachesTheRow_NotJustTheTree()
    {
        var service = Service();
        var created = service.CreateRecord(_mod.Plugin, "npc_", "BrandNewNpc");
        Assert.True(created.Applied, created.Message);
        var createdFormKey = RequireNewFormKey(created);

        Assert.True(service.Set(_mod.Plugin, createdFormKey, "EditorID", Json("\"RenamedNpc\"")).Applied);

        var document = _mod.Index.Projected().GetDocument(createdFormKey, _mod.Plugin).Require();
        Assert.Equal("RenamedNpc", document.EditorId);
        Assert.Contains("RenamedNpc", document.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void ARefusedHeaderDelete_LeavesTheHeadersOwnRowStanding()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(_mod.ActualPluginName));

        Assert.False(Service().DeleteRecord(_mod.Plugin, headerFormKey).Applied);

        Assert.NotNull(_mod.Index.Projected().GetDocument(headerFormKey, _mod.Plugin));
    }

    [Fact]
    public void ADeletedRecord_IsGoneAtEffective()
    {
        Assert.True(Service().DeleteRecord(_mod.Plugin, _mod.Npc.ToString()).Applied);

        Assert.Null(_mod.Index.Projected().GetDocument(_mod.Npc.ToString(), _mod.Plugin));
        Assert.NotNull(_mod.Index.Projected().GetDocument(_mod.OtherNpc.ToString(), _mod.Plugin));
    }

    [Fact]
    public void ADeletedNeverCommittedRecord_LeavesNoRow()
    {
        var service = Service();
        var created = service.CreateRecord(_mod.Plugin, "npc_", "BrandNew");
        Assert.True(created.Applied, created.Message);
        var createdFormKey = RequireNewFormKey(created);

        Assert.True(service.DeleteRecord(_mod.Plugin, createdFormKey).Applied);

        Assert.Null(_mod.Index.Projected().GetDocument(createdFormKey, _mod.Plugin));
        Assert.Null(_mod.Index.Projected().HeadDocument(createdFormKey, _mod.Plugin));
    }

    [Fact]
    public void ADelete_LeavesEveryOtherRecordsRowStanding()
    {
        Service().DeleteRecord(_mod.Plugin, _mod.Npc.ToString());

        Assert.NotNull(_mod.Index.Projected().GetDocument(_mod.OtherNpc.ToString(), _mod.Plugin));
    }
}
