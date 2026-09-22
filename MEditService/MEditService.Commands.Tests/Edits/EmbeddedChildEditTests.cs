using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Only three of the five embedded slots can be exercised through a field edit:
/// <c>SchemaReflector</c> publishes no schema for Landscape or NavigationMesh, so neither has a field to
/// write.</summary>
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

    // ---- the parent's untouched bytes are untouched ----

    [Fact]
    public void EditingAnEmbeddedPlacedRefsField_RewritesOnlyThatFieldInTheOwningCellsFile()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var before = File.ReadAllText(file);
        // Positive control for every Assert.Empty(GitStatus()) in the refusal tests below: Track has just
        // committed the pristine tree, so without this those emptiness assertions could pass for the
        // wrong reason.
        Assert.Empty(_fixture.GitStatus());

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_fixture.GitStatus());
        // The two placed refs carry distinct scales in the fixture precisely so this substitution is
        // unique: a shared value would make the assertion pass for an edit that hit both.
        Assert.Equal(before.Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal), File.ReadAllText(file));
    }

    [Fact]
    public void EditingAnEmbeddedChild_LeavesTheParentsOwnFieldsAlone()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);

        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("7.0")).Applied);

        // The cell's own WaterHeight is a field of the parent, not of the child. A read-modify-write that
        // reserialized the parent from anything other than its own text would be free to move it.
        var after = File.ReadAllText(file);
        Assert.Contains("\"WaterHeight\": 10.0", after, StringComparison.Ordinal);
        Assert.Contains($"\"EditorID\": \"{ContainerModPlugin.EmbedCellEditorId}\"", after, StringComparison.Ordinal);
    }

    // ---- both rows move, and the parent reads dirty ----

    [Fact]
    public void AfterAnEmbeddedEdit_TheChildsOwnDocumentCarriesTheNewValue()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("3.5")).Applied);

        // Cut back out of its owner's document by the repository, which is the only place it exists.
        var child = _fixture.Document(_fixture.TemporaryRef.ToString());
        Assert.NotNull(child);
        Assert.Contains("\"Scale\": 3.5", child.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void AfterAnEmbeddedEdit_TheOwningCellDivergesFromHead()
    {
        // Clean before: the tree is exactly what Track committed, so both refs agree.
        Assert.Equal(CommittedCell(), WorkingTreeCell());

        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("4.5")).Applied);

        // The parent is the source unit, so the parent is what went dirty, which is what makes the edit
        // visible as a working-tree change on the record the file actually belongs to.
        Assert.NotEqual(CommittedCell(), WorkingTreeCell());
        Assert.Contains("\"Scale\": 4.5", WorkingTreeCell(), StringComparison.Ordinal);
        Assert.DoesNotContain("\"Scale\": 4.5", CommittedCell(), StringComparison.Ordinal);
    }

    // ---- The spatial columns a write may not touch ----

    [Fact]
    public void APlacedRefsPosition_IsRefused_SoItsPlacementRowCannotGoStale()
    {
        // The reflector's general P3Int16/P3Float mapping makes `position` an ordinary writable column on
        // every IPlacedGetter, so RefuseIfContainmentField refuses it by name: Position is mirrored into
        // `placement` and nothing on this write path re-derives that row.
        var before = _fixture.Document(_fixture.TemporaryRef.ToString()).Require().Body;

        var result = EditService().Set(
            _fixture.Plugin, _fixture.TemporaryRef.ToString(), "Position", Json("""{"X": 99.0, "Y": 88.0, "Z": 77.0}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("placement", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Document(_fixture.TemporaryRef.ToString()).Require().Body);
        // No working-tree dirt at all from a refused edit.
        Assert.Empty(_fixture.GitStatus());
    }

    [Fact]
    public void ACellsChildSlots_AreRefused_SoContainerChildCannotGoStale()
    {
        // Writing one would swap a container's child set through a JSON blob, leaving the replaced
        // children with rows and parentage but no parent: silent index corruption, not an edit.
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

        // An inline reorder is the same structural gesture, refused the same way, so container_child
        // and placement rows can only ever be re-derived from a document the codec wrote whole.
        var reorder = service.Edit(_fixture.Plugin, _fixture.EmbedCell.ToString(), MoveTo(1, Member("NavigationMeshes"), At(0)));
        Assert.False(reorder.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, reorder.Refusal);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, topCell.Refusal);

        // The child records are all still exactly where they were — inline in the cell's own document.
        var cell = WorkingTreeCell();
        Assert.Contains(_fixture.Navmesh.ToString(), cell, StringComparison.Ordinal);
        Assert.Contains(_fixture.Landscape.ToString(), cell, StringComparison.Ordinal);
        // ...and three refusals leave not one byte of tree dirt.
        Assert.Empty(_fixture.GitStatus());
    }

    [Fact]
    public void ACellsGrid_IsRefused_SoCellLocationCannotGoStale()
    {
        // An exterior cell's grid coordinates *are* its source directory, so moving them restructures
        // the tree rather than rewriting a file — and the same two numbers are mirrored in
        // cell_location, which nothing on the write path re-derives.
        var result = EditService().Set(
            _fixture.Plugin, _fixture.EmbedCell.ToString(), "Grid", Json("""{"Point": {"X": 9, "Y": 9}}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        // Asserted on the durable reason, not on a ticket number: compile-from-tree deliberately
        // gave nothing the power to *move* a record within that structure, so the refusal stands.
        Assert.Contains("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.GitStatus());
    }

    // ---- The embedded slots that are editable at all ----

    [Fact]
    public void EveryEditableEmbeddedSlot_ResolvesToItsOwningContainersFile()
    {
        // Three of the five embedded slots, which is all a field edit can reach: Cell.Landscape and
        // Cell.NavigationMeshes hold record types SchemaReflector publishes no schema for, so there is no
        // field on either to write.
        var service = EditService();

        Assert.True(service.Set(_fixture.Plugin, _fixture.PersistentRef.ToString(), "Scale", Json("2.0")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("3.0")).Applied);
        // TopCell is embedded in the *worldspace's* document, so its source unit is a different file
        // from the two above — the case that falls through a resolver built only for cells.
        Assert.True(service.Set(_fixture.Plugin, _fixture.TopCell.ToString(), "WaterHeight", Json("42.0")).Applied);

        var cellFile = File.ReadAllText(_fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId));
        Assert.Contains("\"Scale\": 2.0", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"Scale\": 3.0", cellFile, StringComparison.Ordinal);

        // The top cell has no file of its own anywhere in the tree — that is what "embedded" means, and
        // it is why locating it by content finds the worldspace's own document.
        var worldspaceFile = _fixture.SourceFileContaining(ContainerModPlugin.WorldspaceEditorId);
        Assert.Contains("\"WaterHeight\": 42.0", File.ReadAllText(worldspaceFile), StringComparison.Ordinal);
        Assert.Equal(worldspaceFile, _fixture.SourceFileContaining(ContainerModPlugin.TopCellEditorId));
    }

    // ---- containment nests deeper than one level inside a single document ----

    [Fact]
    public void APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneFile()
    {
        // worldspace RecordData.json → TopCell (embedded) → Temporary[0] (embedded). The ref has no
        // file of its own and no directory of its own; the only bytes it exists in are the
        // worldspace's. A one-level search refused this with SourceUnitNotFound.
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

    // ---- a record the tree does not hold, both branches ----

    [Fact]
    public void EditingARecordWhoseSourceDirectoryIsGone_RefusesAsRecordNotFound()
    {
        // Branch one: no document of its own, and no other record's document carries it. An interior
        // cell removed from disk by something outside Modbench is exactly that, and the tree is the
        // only thing asked (ADR-0015 invariant 5).
        Directory.Delete(PathShape.DirectoryOf(_fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId)), recursive: true);

        var result = EditService().Set(_fixture.Plugin, _fixture.EmbedCell.ToString(), "WaterHeight", Json("77.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(_fixture.EmbedCell.ToString(), result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAnEmbeddedChildAbsentFromItsParentsSourceText_RefusesAsRecordNotFound()
    {
        // Branch two: the document that carried the child has been edited out from under it, so the
        // locator answers absent rather than naming a document whose own text lacks the child.
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var withoutTheRef = System.Text.RegularExpressions.Regex.Replace(
            File.ReadAllText(file), $@"\s*\{{[^{{}}]*""{ContainerModPlugin.TemporaryRefEditorId}""[^{{}}]*\}},?", "",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        Assert.DoesNotContain(ContainerModPlugin.TemporaryRefEditorId, withoutTheRef, StringComparison.Ordinal);
        File.WriteAllText(file, withoutTheRef);

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("5.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        // The message states what is observed and does not assert an external change as the cause —
        // it is a defect report as often as it is a stale read.
        Assert.DoesNotContain("changed outside Modbench", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeletingAKeyTheOwningDocumentOnlyReferences_RefusesRatherThanReportingASuccess()
    {
        // A FormKey outside every embed slot is a reference, not a child, so no document holds the
        // record and the refusal says that rather than claiming the delete landed.
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var withoutTheRef = System.Text.RegularExpressions.Regex.Replace(
            File.ReadAllText(file), $@"\s*\{{[^{{}}]*""{ContainerModPlugin.TemporaryRefEditorId}""[^{{}}]*\}},?", "",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        File.WriteAllText(
            file,
            withoutTheRef.TrimEnd().TrimEnd('}')
            + $",\n  \"NotAChild\": {{ \"FormKey\": \"{_fixture.TemporaryRef}\" }}\n}}");

        var result = _fixture.DeleteHandler.DeleteRecord(_fixture.Plugin, _fixture.TemporaryRef.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains("no record's document carries it", result.Message, StringComparison.Ordinal);
    }

    // ---- the fifth guarded slot ----

    [Fact]
    public void AWorldspacesSubCells_AreRefused_LikeItsTopCell()
    {
        // The one child-slot column the guard covers that nothing else here exercises. Writing it would
        // replace a worldspace's entire exterior cell tree through a JSON blob.
        var result = EditService().Set(_fixture.Plugin, _fixture.Worldspace.ToString(), "SubCells", Json("[]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.GitStatus());
    }

    // ---- the container rename covers every directory-per-record type ----

    [Fact]
    public void EditingAWorldspacesEditorId_MovesItsSourceDirectory()
    {
        var oldDirectory = PathShape.DirectoryOf(_fixture.SourceFileContaining(ContainerModPlugin.WorldspaceEditorId));

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
        // Every child is still inside its quest, under the quest's new name.
        foreach (var child in new[] { ContainerModFixture.DialogTopicEditorId, ContainerModFixture.ResponseEditorId, ContainerModFixture.DialogBranchEditorId, ContainerModFixture.SceneEditorId })
            Assert.Equal(newFile, _fixture.SourceFileContaining(child));
    }

    // The refusal names the document the gesture resolved (ADR-0015 invariant 5): an empty path would
    // send the author looking for a file with no name.
    [Fact]
    public void EditingAnEmbeddedChild_WhoseOwnerTheTreeNoLongerHolds_RefusesNamingTheDocument()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var declared = $"\"FormKey\": \"{_fixture.EmbedCell}\"";
        var text = File.ReadAllText(file);
        Assert.Contains(declared, text, StringComparison.Ordinal);
        // A hand edit that moves the owner's own FormKey leaves this write nothing to read.
        File.WriteAllText(file, ReplaceFirst(text, declared, "\"FormKey\": \"00FFFF:Absent.esp\""));

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
