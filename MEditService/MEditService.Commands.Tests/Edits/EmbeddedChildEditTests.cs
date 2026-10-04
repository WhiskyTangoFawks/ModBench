using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed partial class EmbeddedChildEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private EditRecordHandler EditService() => _fixture.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string WorkingTreeCell() => _fixture.Document(_fixture.EmbedCell.ToString()).Require().Body;

    [Fact]
    public void EditingAnEmbeddedPlacedRefsField_RewritesOnlyThatFieldInTheOwningCellsDocument()
    {
        var before = EmbedCellDocument().Body;
        Assert.Empty(_fixture.ChangedFormKeys());

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_fixture.ChangedFormKeys());
        Assert.Equal(before.Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal), EmbedCellDocument().Body);
    }

    [Fact]
    public void EditingAnEmbeddedChild_LeavesTheParentsOwnFieldsAlone()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("7.0")).Applied);

        var after = EmbedCellDocument().Body;
        Assert.Contains("\"WaterHeight\": 10.0", after, StringComparison.Ordinal);
        Assert.Contains($"\"EditorID\": \"{ContainerModPlugin.EmbedCellEditorId}\"", after, StringComparison.Ordinal);
    }

    [Fact]
    public void AfterAnEmbeddedEdit_TheChildsOwnDocumentCarriesTheNewValue()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("3.5")).Applied);

        var child = _fixture.Document(_fixture.TemporaryRef.ToString());
        Assert.NotNull(child);
        Assert.Contains("\"Scale\": 3.5", child.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void AfterAnEmbeddedEdit_TheOwningCellDivergesFromHead()
    {
        Assert.DoesNotContain(_fixture.EmbedCell.ToString(), _fixture.ChangedFormKeys());

        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("4.5")).Applied);

        Assert.Contains(_fixture.EmbedCell.ToString(), _fixture.ChangedFormKeys());
        Assert.Contains("\"Scale\": 4.5", WorkingTreeCell(), StringComparison.Ordinal);
    }

    [Fact]
    public void APlacedRefsPosition_IsRefused_SoItsPlacementRowCannotGoStale()
    {
        var before = _fixture.Document(_fixture.TemporaryRef.ToString()).Require().Body;

        var result = EditService().Set(
            _fixture.Plugin, _fixture.TemporaryRef.ToString(), "Position", Json("""{"X": 99.0, "Y": 88.0, "Z": 77.0}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("placement", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Document(_fixture.TemporaryRef.ToString()).Require().Body);
        Assert.Empty(_fixture.ChangedFormKeys());
    }

    [Fact]
    public void ACellsChildSlots_AreRefused_SoContainerChildCannotGoStale()
    {
        var service = EditService();

        var navmeshes = service.Set(_fixture.Plugin, _fixture.EmbedCell.ToString(), "NavigationMeshes", Json("[]"));
        Assert.False(navmeshes.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, navmeshes.Refusal);
        Assert.Contains("structural gesture", navmeshes.Message, StringComparison.Ordinal);

        var landscape = service.Set(_fixture.Plugin, _fixture.EmbedCell.ToString(), "Landscape", Json("null"));
        Assert.False(landscape.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, landscape.Refusal);

        var topCell = service.Set(_fixture.Plugin, _fixture.Worldspace.ToString(), "TopCell", Json("null"));
        Assert.False(topCell.Applied);

        var reorder = service.Edit(_fixture.Plugin, _fixture.EmbedCell.ToString(), MoveTo(1, Member("NavigationMeshes"), At(0)));
        Assert.False(reorder.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, reorder.Refusal);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, topCell.Refusal);

        var cell = WorkingTreeCell();
        Assert.Contains(_fixture.Navmesh.ToString(), cell, StringComparison.Ordinal);
        Assert.Contains(_fixture.Landscape.ToString(), cell, StringComparison.Ordinal);
        Assert.Empty(_fixture.ChangedFormKeys());
    }

    [Fact]
    public void ACellsGrid_IsRefused_SoCellLocationCannotGoStale()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.EmbedCell.ToString(), "Grid", Json("""{"Point": {"X": 9, "Y": 9}}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.ChangedFormKeys());
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

        var result = _fixture.DeleteHandler.DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.TemporaryRef.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
        Assert.Contains("no record's document carries it", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AWorldspacesSubCells_AreRefused_LikeItsTopCell()
    {
        var result = EditService().Set(_fixture.Plugin, _fixture.Worldspace.ToString(), "SubCells", Json("[]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.ChangedFormKeys());
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
