using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed partial class EmbeddedChildEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private TestEditor EditService() => _fixture.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string WorkingTreeCell() => _fixture.Document(_fixture.EmbedCell.ToString()).Require().Body;

    public static TheoryData<Func<ContainerModFixture, FormKey>, string, string, string?, RecordEditRefusal, string> SlotsThatAreStructural => new()
    {
        { f => f.EmbedCell, RecordEditEnvelope.Set, "NavigationMeshes", "[]", RecordEditRefusal.FieldReadOnly, "not by editing the slot" },
        { f => f.EmbedCell, RecordEditEnvelope.Set, "Landscape", "null", RecordEditRefusal.FieldReadOnly, "not by editing the slot" },
        { f => f.Worldspace, RecordEditEnvelope.Set, "TopCell", "null", RecordEditRefusal.FieldReadOnly, "not by editing the slot" },
        { f => f.Worldspace, RecordEditEnvelope.Set, "SubCells", "[]", RecordEditRefusal.FieldReadOnly, "not by editing the slot" },
        { f => f.EmbedCell, RecordEditEnvelope.Move, "NavigationMeshes[0]", "1", RecordEditRefusal.FieldReadOnly, "not by editing the slot" },
        { f => f.EmbedCell, RecordEditEnvelope.Set, "Grid", """{"Point": {"X": 9, "Y": 9}}""", RecordEditRefusal.FieldReadOnly, "structural gesture" },
        { f => f.EmbedCell, RecordEditEnvelope.Set, "Grid.Point", "\"9, 9\"", RecordEditRefusal.FieldReadOnly, "structural gesture" },
        { f => f.EmbedCell, RecordEditEnvelope.Remove, "NavigationMeshes[5]", null, RecordEditRefusal.FieldNotFound, "names no element" },
        { f => f.EmbedCell, RecordEditEnvelope.Move, "NavigationMeshes[5]", "0", RecordEditRefusal.FieldNotFound, "names no element" },
    };

    [Fact]
    public void EditingAnEmbeddedChild_RewritesItsOwnersDocument_ThatDivergesFromHead_AndTheChildReadsItBack()
    {
        Assert.Empty(_fixture.ChangedFormKeys());

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains(_fixture.EmbedCell.ToString(), _fixture.ChangedFormKeys());
        Assert.Contains("\"Scale\": 2.5", WorkingTreeCell(), StringComparison.Ordinal);
        Assert.Contains("\"Scale\": 2.5", _fixture.Document(_fixture.TemporaryRef.ToString()).Require().Body, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(SlotsThatAreStructural))]
    public void AStructuralSlot_IsRefused_SoContainerChildAndCellLocationCannotGoStale(
        Func<ContainerModFixture, FormKey> record, string op, string path, string? value, RecordEditRefusal refusal, string reason)
    {
        var result = EditService().Edit(_fixture.Plugin, record(_fixture).ToString(), Spelled(op, path, value));

        Assert.False(result.Applied);
        Assert.Equal(refusal, result.Refusal);
        Assert.Contains(reason, result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.ChangedFormKeys());
    }

    [Fact]
    public void AnExteriorTemporaryRefMovedOutsideItsCellsGrid_StaysInItsOwnCellsDocument()
    {
        var outsideGrid = "\"90000, -90000, 0\"";

        var result = EditService().Set(_fixture.Plugin, _fixture.ExteriorRef.ToString(), "Position", Json(outsideGrid));

        Assert.True(result.Applied, result.Message);
        var owner = _fixture.DocumentCarrying("ExteriorCell").Body;
        Assert.Contains("\"EditorID\": \"ExteriorRef\"", owner, StringComparison.Ordinal);
        Assert.Contains("\"Position\": \"90000, -90000, 0\"", owner, StringComparison.Ordinal);
        Assert.Contains(_fixture.ExteriorCell.ToString(), _fixture.ChangedFormKeys());
    }

    [Fact]
    public void EveryEmbeddedSlot_ResolvesToItsOwningContainersDocument()
    {
        var service = EditService();

        Assert.True(service.Set(_fixture.Plugin, _fixture.PersistentRef.ToString(), "Scale", Json("2.0")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("3.0")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.Landscape.ToString(), "EditorID", Json("\"EditedLandscape\"")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.Navmesh.ToString(), "EditorID", Json("\"EditedNavmesh\"")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.TopCell.ToString(), "WaterHeight", Json("42.0")).Applied);

        var cellFile = EmbedCellDocument().Body;
        Assert.Contains("\"Scale\": 2.0", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"Scale\": 3.0", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"EditedLandscape\"", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"EditedNavmesh\"", cellFile, StringComparison.Ordinal);

        var worldspace = _fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId);
        Assert.Contains("\"WaterHeight\": 42.0", worldspace.Body, StringComparison.Ordinal);
        Assert.Equal(worldspace.FormKey, _fixture.DocumentCarrying(ContainerModPlugin.TopCellEditorId).FormKey);
    }

    [Fact]
    public void APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneDocument()
    {
        var before = _fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId).Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.TopCellRef.ToString(), "Scale", Json("9.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace("\"Scale\": 6.0", "\"Scale\": 9.5", StringComparison.Ordinal),
            _fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId).Body);
        Assert.Contains(
            "\"Scale\": 9.5", _fixture.Document(_fixture.TopCellRef.ToString()).Require().Body, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingARecordTheTreeNoLongerHolds_RefusesAsRecordNotFound()
    {
        _fixture.Remove(new RecordIdentity(_fixture.EmbedCell.ToString(), "cell", ContainerModPlugin.EmbedCellEditorId));

        var result = EditService().Set(_fixture.Plugin, _fixture.EmbedCell.ToString(), "WaterHeight", Json("77.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(_fixture.EmbedCell.ToString(), result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAnEmbeddedChildAbsentFromItsParentsSourceText_RefusesAsRecordNotFound()
    {
        var cell = EmbedCellDocument();
        var withoutTheRef = WithoutTheTemporaryRef(cell.Body);
        Assert.DoesNotContain(ContainerModPlugin.TemporaryRefEditorId, withoutTheRef, StringComparison.Ordinal);
        _fixture.Overwrite(cell with { Body = withoutTheRef });

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("5.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }

    [Fact]
    public void DeletingAKeyTheOwningDocumentOnlyReferences_RefusesRatherThanReportingASuccess()
    {
        var cell = EmbedCellDocument();
        _fixture.Overwrite(cell with
        {
            Body = WithoutTheTemporaryRef(cell.Body).TrimEnd().TrimEnd('}')
                   + $",\n  \"NotAChild\": {{ \"FormKey\": \"{_fixture.TemporaryRef}\" }}\n}}",
        });

        var result = _fixture.DeleteHandler.DeleteRecordsSync([new RecordAt(_fixture.Plugin, _fixture.TemporaryRef.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
        Assert.Contains("no record's document carries it", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAWorldspacesEditorId_LandsTheNewNameOnItsDocument()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.Worldspace.ToString(), "EditorID", Json("\"RenamedWorld\"")).Applied);

        var renamed = _fixture.DocumentCarrying("RenamedWorld");
        Assert.Equal(_fixture.Worldspace.ToString(), renamed.FormKey);
        Assert.Contains("\"EditorID\": \"RenamedWorld\"", renamed.Body, StringComparison.Ordinal);
        Assert.Equal(renamed.FormKey, _fixture.DocumentCarrying(ContainerModPlugin.TopCellEditorId).FormKey);
    }

    [Fact]
    public void EditingAQuestsEditorId_RenamesItsDocument_AndItsChildrenStayInsideIt()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.Quest.ToString(), "EditorID", Json("\"RenamedQuest\"")).Applied);

        var renamed = _fixture.DocumentCarrying("RenamedQuest");
        Assert.Equal(_fixture.Quest.ToString(), renamed.FormKey);
        foreach (var child in new[] { ContainerModFixture.DialogTopicEditorId, ContainerModFixture.ResponseEditorId, ContainerModFixture.DialogBranchEditorId, ContainerModFixture.SceneEditorId })
            Assert.Equal(renamed.FormKey, _fixture.DocumentCarrying(child).FormKey);
    }

    [Fact]
    public void EditingAnEmbeddedChild_WhoseOwnerDocumentNamesNoRecord_RefusesAsUnreadableNamingTheDocument()
    {
        var cell = EmbedCellDocument();
        var file = TreeTampering.FileOf(
            _fixture.ModFolder, _fixture.Plugin, new RecordIdentity(cell.FormKey, cell.RecordType, cell.EditorId));
        var declared = $"\"FormKey\": \"{_fixture.EmbedCell}\"";
        Assert.Contains(declared, cell.Body, StringComparison.Ordinal);
        _fixture.Overwrite(cell with { Body = ReplaceFirst(cell.Body, declared, "\"FormKey\": \"NotAFormKey\"") });

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(
            Path.GetRelativePath(_fixture.ModFolder, file), result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("moved or removed", result.Message, StringComparison.Ordinal);
    }

    private SourceDocument EmbedCellDocument() => _fixture.DocumentCarrying(ContainerModPlugin.EmbedCellEditorId);

    private static string WithoutTheTemporaryRef(string cellBody) =>
        MyRegex().Replace(cellBody, "");

    private static string ReplaceFirst(string text, string what, string with)
    {
        var at = text.IndexOf(what, StringComparison.Ordinal);
        return text[..at] + with + text[(at + what.Length)..];
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"\s*\{[^{}]*""TempRef""[^{}]*\},?", System.Text.RegularExpressions.RegexOptions.Singleline)]
    private static partial System.Text.RegularExpressions.Regex MyRegex();
}
