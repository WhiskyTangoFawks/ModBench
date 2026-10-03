using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class EmbeddedChildEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private EditRecordHandler EditService() => _fixture.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string WorkingTreeCell() => _fixture.Document(_fixture.EmbedCell.ToString()).Require().Body;

    private string CommittedCell() =>
        _fixture.CommittedDocument(
            _fixture.EmbedCell.ToString(), "cell", ContainerModPlugin.EmbedCellEditorId).Require().Body;

    [Fact]
    public void EditingAnEmbeddedPlacedRefsField_RewritesOnlyThatFieldInTheOwningCellsFile()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var before = File.ReadAllText(file);
        Assert.Empty(_fixture.GitStatus());

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_fixture.GitStatus());
        Assert.Equal(before.Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal), File.ReadAllText(file));
    }

    [Fact]
    public void EditingAnEmbeddedChild_LeavesTheParentsOwnFieldsAlone()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);

        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("7.0")).Applied);

        var after = File.ReadAllText(file);
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
        Assert.Equal(CommittedCell(), WorkingTreeCell());

        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("4.5")).Applied);

        Assert.NotEqual(CommittedCell(), WorkingTreeCell());
        Assert.Contains("\"Scale\": 4.5", WorkingTreeCell(), StringComparison.Ordinal);
        Assert.DoesNotContain("\"Scale\": 4.5", CommittedCell(), StringComparison.Ordinal);
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
        Assert.Empty(_fixture.GitStatus());
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
        Assert.Empty(_fixture.GitStatus());
    }

    [Fact]
    public void ACellsGrid_IsRefused_SoCellLocationCannotGoStale()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.EmbedCell.ToString(), "Grid", Json("""{"Point": {"X": 9, "Y": 9}}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.GitStatus());
    }

    [Fact]
    public void EveryEmbeddedSlot_ResolvesToItsOwningContainersFile()
    {
        var service = EditService();

        Assert.True(service.Set(_fixture.Plugin, _fixture.PersistentRef.ToString(), "Scale", Json("2.0")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("3.0")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.Landscape.ToString(), "EditorID", Json("\"EditedLandscape\"")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.Navmesh.ToString(), "EditorID", Json("\"EditedNavmesh\"")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.TopCell.ToString(), "WaterHeight", Json("42.0")).Applied);

        var cellFile = File.ReadAllText(_fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId));
        Assert.Contains("\"Scale\": 2.0", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"Scale\": 3.0", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"EditedLandscape\"", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"EditedNavmesh\"", cellFile, StringComparison.Ordinal);

        var worldspaceFile = _fixture.SourceFileContaining(ContainerModPlugin.WorldspaceEditorId);
        Assert.Contains("\"WaterHeight\": 42.0", File.ReadAllText(worldspaceFile), StringComparison.Ordinal);
        Assert.Equal(worldspaceFile, _fixture.SourceFileContaining(ContainerModPlugin.TopCellEditorId));
    }

    [Fact]
    public void APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneFile()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.WorldspaceEditorId);
        var before = File.ReadAllText(file);

        var result = EditService().Set(_fixture.Plugin, _fixture.TopCellRef.ToString(), "Scale", Json("9.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace("\"Scale\": 6.0", "\"Scale\": 9.5", StringComparison.Ordinal),
            File.ReadAllText(file));
        Assert.Contains(
            "\"Scale\": 9.5", _fixture.Document(_fixture.TopCellRef.ToString()).Require().Body, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingARecordWhoseSourceDirectoryIsGone_RefusesAsRecordNotFound()
    {
        var embedCellFile = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        Directory.Delete(Path.GetDirectoryName(embedCellFile)
            ?? throw new InvalidOperationException($"Expected '{embedCellFile}' to have a parent directory."), recursive: true);

        var result = EditService().Set(_fixture.Plugin, _fixture.EmbedCell.ToString(), "WaterHeight", Json("77.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(_fixture.EmbedCell.ToString(), result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAnEmbeddedChildAbsentFromItsParentsSourceText_RefusesAsRecordNotFound()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var withoutTheRef = System.Text.RegularExpressions.Regex.Replace(
            File.ReadAllText(file), $@"\s*\{{[^{{}}]*""{ContainerModPlugin.TemporaryRefEditorId}""[^{{}}]*\}},?", "",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        Assert.DoesNotContain(ContainerModPlugin.TemporaryRefEditorId, withoutTheRef, StringComparison.Ordinal);
        File.WriteAllText(file, withoutTheRef);

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("5.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }

    [Fact]
    public void DeletingAKeyTheOwningDocumentOnlyReferences_RefusesRatherThanReportingASuccess()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var withoutTheRef = System.Text.RegularExpressions.Regex.Replace(
            File.ReadAllText(file), $@"\s*\{{[^{{}}]*""{ContainerModPlugin.TemporaryRefEditorId}""[^{{}}]*\}},?", "",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        File.WriteAllText(
            file,
            withoutTheRef.TrimEnd().TrimEnd('}')
            + $",\n  \"NotAChild\": {{ \"FormKey\": \"{_fixture.TemporaryRef}\" }}\n}}");

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
        Assert.Empty(_fixture.GitStatus());
    }

    [Fact]
    public void EditingAWorldspacesEditorId_MovesItsSourceDirectory()
    {
        var worldspaceFile = _fixture.SourceFileContaining(ContainerModPlugin.WorldspaceEditorId);
        var oldDirectory = Path.GetDirectoryName(worldspaceFile)
            ?? throw new InvalidOperationException($"Expected '{worldspaceFile}' to have a parent directory.");

        Assert.True(EditService().Set(_fixture.Plugin, _fixture.Worldspace.ToString(), "EditorID", Json("\"RenamedWorld\"")).Applied);

        Assert.False(Directory.Exists(oldDirectory));
        Assert.Contains(
            "\"EditorID\": \"RenamedWorld\"",
            File.ReadAllText(_fixture.SourceFileContaining("RenamedWorld")),
            StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAQuestsEditorId_RenamesItsFile_AndItsChildrenStayInsideIt()
    {
        var oldFile = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);
        Assert.Equal(oldFile, _fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId));

        Assert.True(EditService().Set(_fixture.Plugin, _fixture.Quest.ToString(), "EditorID", Json("\"RenamedQuest\"")).Applied);

        Assert.False(File.Exists(oldFile));
        var newFile = _fixture.SourceFileContaining("RenamedQuest");
        Assert.Equal(Path.GetDirectoryName(oldFile), Path.GetDirectoryName(newFile));
        foreach (var child in new[] { ContainerModFixture.DialogTopicEditorId, ContainerModFixture.ResponseEditorId, ContainerModFixture.DialogBranchEditorId, ContainerModFixture.SceneEditorId })
            Assert.Equal(newFile, _fixture.SourceFileContaining(child));
    }

    [Fact]
    public void EditingAnEmbeddedChild_WhoseOwnerTheTreeNoLongerHolds_RefusesNamingTheDocument()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var declared = $"\"FormKey\": \"{_fixture.EmbedCell}\"";
        var text = File.ReadAllText(file);
        Assert.Contains(declared, text, StringComparison.Ordinal);
        File.WriteAllText(file, ReplaceFirst(text, declared, "\"FormKey\": \"NotAFormKey\""));

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, result.Refusal);
        Assert.StartsWith(
            Path.GetRelativePath(_fixture.ModFolder, file), result.Message, StringComparison.Ordinal);
    }

    private static string ReplaceFirst(string text, string what, string with)
    {
        var at = text.IndexOf(what, StringComparison.Ordinal);
        return text[..at] + with + text[(at + what.Length)..];
    }
}
