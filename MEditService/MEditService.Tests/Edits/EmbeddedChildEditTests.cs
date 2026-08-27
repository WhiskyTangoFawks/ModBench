using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #453 slice 2: a field edit on a record that has <b>no source file of its own</b> — one of the five
/// slots Spriggit embeds inline in its parent's document
/// (<c>Cell.{Persistent,Temporary,Landscape,NavigationMeshes}</c>, <c>Worldspace.TopCell</c>). The edit
/// reads the parent's file, applies the field to the child inside the parent's own object graph, and
/// writes the parent back — so the child's bytes move without the parent's own fields being touched.
///
/// <para>Runs against the shared <see cref="ContainerModFixture"/> (#466), which carries every one of
/// the five embedded slots at once plus the Worldspace/TopCell and Quest/DialogTopic shapes this suite
/// exercises — so a resolver that handles placed references and quietly fails on a worldspace's top
/// cell cannot pass. Its content is this suite's own original local fixture, carried forward
/// unchanged: <see cref="ContainerModFixture.EmbedCell"/> is exactly the Cell this file used to build
/// for itself, before #466 consolidated it with the local fixtures in
/// <c>Source.ContainerRecordRegressionTests</c> and <c>Source.SourceIngestContainerTests</c>.</para>
///
/// <para><b>Only three of the five slots can be exercised through a field edit</b>, and the tests say
/// which and why rather than quietly covering less than the fixture holds:
/// <c>Cell.Landscape</c>/<c>Cell.NavigationMeshes</c> hold Landscape/NavigationMesh records, for which
/// <c>SchemaReflector</c> publishes no schema at all (they are not record types mEdit surfaces), so
/// neither has a field to write. They are still in the fixture, because the guard tests below read
/// their parentage to prove the container's child set survives an edit intact.</para>
/// </summary>
public sealed class EmbeddedChildEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ---- AC1: the parent's untouched bytes are untouched ----

    [Fact]
    public void EditingAnEmbeddedPlacedRefsField_RewritesOnlyThatFieldInTheOwningCellsFile()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        var before = File.ReadAllText(file);
        // Positive control for every Assert.Empty(_fixture.GitStatus()) in the refusal tests below:
        // Track has just committed the pristine tree, so the status is empty now and must not be after
        // an edit that actually lands. Without this the emptiness assertions could pass for the wrong
        // reason.
        Assert.Empty(_fixture.GitStatus());

        var result = EditService().EditField(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_fixture.GitStatus());
        // AC1 in its strongest form: every byte outside the edited field's own text is identical.
        // The two placed refs carry distinct scales in the fixture precisely so this substitution
        // is unique — a shared value would make the assertion pass for an edit that hit both.
        Assert.Equal(before.Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal), File.ReadAllText(file));
    }

    [Fact]
    public void EditingAnEmbeddedChild_LeavesTheParentsOwnFieldsAlone()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);

        Assert.True(EditService().EditField(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "scale", Json("7.0")).Applied);

        // The cell's own WaterHeight — a field of the parent, not of the child — is untouched, and so
        // is its EditorID. A read-modify-write that reserialized the parent from anything other than
        // its own text would be free to move these.
        var after = File.ReadAllText(file);
        Assert.Contains("\"WaterHeight\": 10.0", after, StringComparison.Ordinal);
        Assert.Contains($"\"EditorID\": \"{ContainerModFixture.EmbedCellEditorId}\"", after, StringComparison.Ordinal);
    }

    // ---- AC4: both rows move, and the parent reads dirty ----

    [Fact]
    public void AfterAnEmbeddedEdit_TheChildsOwnRowCarriesTheNewValue()
    {
        Assert.True(EditService().EditField(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "scale", Json("3.5")).Applied);

        var child = _fixture.Sessions.Index!.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(child);
        Assert.Contains("\"Scale\": 3.5", child!.Body!, StringComparison.Ordinal);
    }

    [Fact]
    public void AfterAnEmbeddedEdit_TheOwningCellReadsDirtyAtEffective()
    {
        var index = _fixture.Sessions.Index!;
        // Clean before: the tree is exactly what Track committed, so both refs agree.
        Assert.Equal(
            index.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.Body,
            index.At(RecordRef.Head).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.Body);

        Assert.True(EditService().EditField(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "scale", Json("4.5")).Applied);

        // The parent is the source unit, so the parent is what went dirty — Effective has moved and
        // Head still holds what was committed. That is what makes the edit visible as a pending
        // change on the record the file actually belongs to.
        var effective = index.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.Body;
        var head = index.At(RecordRef.Head).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.Body;
        Assert.NotEqual(effective, head);
        Assert.Contains("\"Scale\": 4.5", effective!, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Scale\": 4.5", head!, StringComparison.Ordinal);
    }

    // ---- The index's spatial side tables stay correct, because nothing can move them ----

    [Fact]
    public void APlacedRefsPosition_IsNotAWritableField_SoItsPlacementRowCannotGoStale()
    {
        var index = _fixture.Sessions.Index!;
        Assert.Equal(11f, index.GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.Value.PosX);

        var result = EditService().EditField(
            _fixture.Plugin, _fixture.TemporaryRef.ToString(), "position", Json("""{"X": 99.0, "Y": 88.0, "Z": 77.0}"""));

        // `placement`'s only non-containment columns come from Position, and Position is a P3Float,
        // which SchemaReflector.GetColumnInfo does not map — the property is dropped, so `refr` has no
        // `position` column and the write refuses. That is what makes the table unreachable from this
        // gesture, and it is why RecordEditService has no placement write-back: there would be nothing
        // able to make one go red.
        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal(11f, index.GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.Value.PosX);
        // AC3 at the level the AC names: no working-tree dirt at all from a refused edit.
        Assert.Empty(_fixture.GitStatus());
    }

    [Fact]
    public void ACellsChildSlots_AreRefused_SoContainerChildCannotGoStale()
    {
        // Reflection makes these ordinary writable columns, and #453 is what first made a Cell
        // reachable through EditField at all. Writing one would swap a container's child set through a
        // JSON blob, leaving the replaced children with rows and parentage but no parent — silent index
        // corruption, not an edit.
        var service = EditService();

        var navmeshes = service.EditField(_fixture.Plugin, _fixture.EmbedCell.ToString(), "navigation_meshes", Json("[]"));
        Assert.False(navmeshes.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, navmeshes.Refusal);
        Assert.Contains("461", navmeshes.Message, StringComparison.Ordinal);

        var landscape = service.EditField(_fixture.Plugin, _fixture.EmbedCell.ToString(), "landscape", Json("null"));
        Assert.False(landscape.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, landscape.Refusal);

        var topCell = service.EditField(_fixture.Plugin, _fixture.Worldspace.ToString(), "top_cell", Json("null"));
        Assert.False(topCell.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, topCell.Refusal);

        // The child records are all still exactly where they were...
        Assert.Equal(
            _fixture.EmbedCell.ToString(),
            _fixture.Sessions.Index!.GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString())!.Value.ParentFormKey);
        Assert.Equal(
            _fixture.EmbedCell.ToString(),
            _fixture.Sessions.Index!.GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString())!.Value.ParentFormKey);
        // ...and AC3's own claim, at the level it names: three refusals, not one byte of tree dirt.
        Assert.Empty(_fixture.GitStatus());
    }

    [Fact]
    public void ACellsGrid_IsRefused_SoCellLocationCannotGoStale()
    {
        // An exterior cell's grid coordinates *are* its source directory, so moving them restructures
        // the tree rather than rewriting a file — and the same two numbers are mirrored in
        // cell_location, which nothing on the write path re-derives.
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.EmbedCell.ToString(), "grid", Json("""{"Point": {"X": 9, "Y": 9}}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        // Asserted on the durable reason, not on a ticket number: #454 landed compile-from-tree and
        // deliberately did not make anything *move* a record within that structure, so the refusal
        // stands and the message no longer forward-references a ticket.
        Assert.Contains("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.GitStatus());
    }

    // ---- The embedded slots that are editable at all ----

    [Fact]
    public void EveryEditableEmbeddedSlot_ResolvesToItsOwningContainersFile()
    {
        // Three of the five embedded slots, which is all of them that a field edit can reach:
        // Cell.Landscape and Cell.NavigationMeshes hold Landscape/NavigationMesh records, and
        // SchemaReflector deliberately publishes no schema for `land`/`navm` at all (they are not
        // record types mEdit surfaces), so there is no field on either to write. The resolver still
        // resolves them — ACellsChildSlots_AreRefused above reads their parentage — but nothing can
        // exercise that through EditField, so this test does not pretend to.
        var service = EditService();

        Assert.True(service.EditField(_fixture.Plugin, _fixture.PersistentRef.ToString(), "scale", Json("2.0")).Applied);
        Assert.True(service.EditField(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "scale", Json("3.0")).Applied);
        // TopCell is embedded in the *worldspace's* document, so its source unit is a different file
        // from the two above — the case that falls through a resolver built only for cells.
        Assert.True(service.EditField(_fixture.Plugin, _fixture.TopCell.ToString(), "water_height", Json("42.0")).Applied);

        var cellFile = File.ReadAllText(_fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId));
        Assert.Contains("\"Scale\": 2.0", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"Scale\": 3.0", cellFile, StringComparison.Ordinal);

        // The top cell has no file of its own anywhere in the tree — that is what "embedded" means, and
        // it is why locating it by content finds the worldspace's own document.
        var worldspaceFile = _fixture.SourceFileContaining(ContainerModFixture.WorldspaceEditorId);
        Assert.Contains("\"WaterHeight\": 42.0", File.ReadAllText(worldspaceFile), StringComparison.Ordinal);
        Assert.Equal(worldspaceFile, _fixture.SourceFileContaining(ContainerModFixture.TopCellEditorId));
    }

    // ---- Finding 2: containment nests deeper than one level inside a single document ----

    [Fact]
    public void APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneFile()
    {
        // worldspace RecordData.json → TopCell (embedded) → Temporary[0] (embedded). The ref has no
        // file of its own and no directory of its own; the only bytes it exists in are the
        // worldspace's. A one-level search refused this with SourceUnitNotFound.
        var file = _fixture.SourceFileContaining(ContainerModFixture.WorldspaceEditorId);
        var before = File.ReadAllText(file);

        var result = EditService().EditField(_fixture.Plugin, _fixture.TopCellRef.ToString(), "scale", Json("9.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace("\"Scale\": 6.0", "\"Scale\": 9.5", StringComparison.Ordinal),
            File.ReadAllText(file));
        Assert.Contains(
            "\"Scale\": 9.5",
            _fixture.Sessions.Index!.GetDocument(_fixture.TopCellRef.ToString(), _fixture.Plugin)!.Body!,
            StringComparison.Ordinal);
    }

    [Fact]
    public void AQuestsDialogTopic_IsNotReachedThroughTheQuestsDocument()
    {
        // The bound on the descent, from the other side: a dialog topic is a child of the quest but is
        // folder-split, with its own RecordData.json. Editing it must land in *its* file, never in the
        // quest's — a search that descended into every child slot would write the change into the
        // quest's document and lose it, because compile and ingest read the topic's own file.
        var questFile = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);
        var topicFile = _fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId);
        Assert.NotEqual(questFile, topicFile);

        var questBefore = File.ReadAllText(questFile);
        Assert.True(EditService().EditField(_fixture.Plugin, _fixture.DialogTopic.ToString(), "editor_id", Json("\"RenamedTopic\"")).Applied);

        Assert.Equal(questBefore, File.ReadAllText(questFile));
        Assert.Contains(
            "\"EditorID\": \"RenamedTopic\"",
            File.ReadAllText(_fixture.SourceFileContaining("RenamedTopic")),
            StringComparison.Ordinal);
    }

    // ---- Finding 3: SourceUnitNotFound, both branches ----

    [Fact]
    public void EditingARecordWhoseSourceDirectoryIsGone_RefusesAsSourceUnitNotFound()
    {
        // Branch one: the resolver finds no file and the index names no container that would hold it.
        // An interior cell removed from disk by something outside Modbench is exactly that.
        Directory.Delete(Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId))!, recursive: true);

        var result = EditService().EditField(_fixture.Plugin, _fixture.EmbedCell.ToString(), "water_height", Json("77.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, result.Refusal);
        Assert.Contains(_fixture.EmbedCell.ToString(), result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAnEmbeddedChildTheParentsTextNoLongerCarries_RefusesAsSourceUnitNotFound()
    {
        // Branch two: the resolver finds the parent's file, but the child is not inside it any more —
        // the index still has the placement row while the file has been edited out from under it.
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        var withoutTheRef = System.Text.RegularExpressions.Regex.Replace(
            File.ReadAllText(file), $@"\s*\{{[^{{}}]*""{ContainerModFixture.TemporaryRefEditorId}""[^{{}}]*\}},?", "",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        Assert.DoesNotContain(ContainerModFixture.TemporaryRefEditorId, withoutTheRef, StringComparison.Ordinal);
        File.WriteAllText(file, withoutTheRef);

        var result = EditService().EditField(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "scale", Json("5.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, result.Refusal);
        // The message states what is observed and does not assert an external change as the cause —
        // it is a defect report as often as it is a stale read (#453 review finding 2).
        Assert.DoesNotContain("changed outside Modbench", result.Message, StringComparison.Ordinal);
    }

    // ---- Finding 5: the fifth guarded slot ----

    [Fact]
    public void AWorldspacesSubCells_AreRefused_LikeItsTopCell()
    {
        // The one child-slot column the guard covers that nothing else here exercises. Writing it would
        // replace a worldspace's entire exterior cell tree through a JSON blob.
        var result = EditService().EditField(_fixture.Plugin, _fixture.Worldspace.ToString(), "sub_cells", Json("[]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("461", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.GitStatus());
    }

    // ---- Finding 6: the container rename covers every directory-per-record type ----

    [Fact]
    public void EditingAWorldspacesEditorId_MovesItsSourceDirectory()
    {
        var oldDirectory = Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.WorldspaceEditorId))!;

        Assert.True(EditService().EditField(_fixture.Plugin, _fixture.Worldspace.ToString(), "editor_id", Json("\"RenamedWorld\"")).Applied);

        Assert.False(Directory.Exists(oldDirectory));
        Assert.Contains(
            "\"EditorID\": \"RenamedWorld\"",
            File.ReadAllText(_fixture.SourceFileContaining("RenamedWorld")),
            StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAQuestsEditorId_MovesItsDirectory_AndItsFolderSplitChildrenTravelWithIt()
    {
        // The property the rename's doc comment claims and only a Quest can demonstrate: moving the
        // directory carries the folder-split children inside it, rather than orphaning them under a
        // directory that no longer exists.
        var oldDirectory = Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.QuestEditorId))!;
        Assert.StartsWith(oldDirectory, _fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId), StringComparison.Ordinal);

        Assert.True(EditService().EditField(_fixture.Plugin, _fixture.Quest.ToString(), "editor_id", Json("\"RenamedQuest\"")).Applied);

        Assert.False(Directory.Exists(oldDirectory));
        var newDirectory = Path.GetDirectoryName(_fixture.SourceFileContaining("RenamedQuest"))!;
        // The dialog topic is still inside its quest, under the quest's new name.
        Assert.StartsWith(newDirectory, _fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId), StringComparison.Ordinal);
    }
}
