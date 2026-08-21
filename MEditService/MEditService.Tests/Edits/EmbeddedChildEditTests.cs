using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// #453 slice 2: a field edit on a record that has <b>no source file of its own</b> — one of the five
/// slots Spriggit embeds inline in its parent's document
/// (<c>Cell.{Persistent,Temporary,Landscape,NavigationMeshes}</c>, <c>Worldspace.TopCell</c>). The edit
/// reads the parent's file, applies the field to the child inside the parent's own object graph, and
/// writes the parent back — so the child's bytes move without the parent's own fields being touched.
///
/// <para><b>Its own local fixture, holding all five embedded slots.</b> The shared
/// <c>TrackedModFixture</c> is Npc/Race/Keyword and holds no container at all, which is structurally
/// why #451 could ship a container regression no test could see; modifying it would put the ~24 files
/// that build on it at risk for no benefit. This follows <c>ContainerRecordRegressionTests</c>' and
/// <c>SourceIngestContainerTests</c>' precedent of a small local fixture instead — one that carries
/// every embedded slot at once, so a resolver that handles placed references and quietly fails on a
/// worldspace's top cell cannot pass.</para>
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
    private const string PluginName = "EmbedFixture.esp";
    private const string Origin = "EmbedFixtureMod";

    private readonly string _modFolder;
    private readonly string _gameDirectory;
    private readonly SessionManager _sessions;
    private readonly PluginKey _plugin = new(PluginName, Origin);

    private readonly FormKey _cell;
    private readonly FormKey _temporaryRef;
    private readonly FormKey _persistentRef;
    private readonly FormKey _navmesh;
    private readonly FormKey _landscape;
    private readonly FormKey _worldspace;
    private readonly FormKey _topCell;
    private readonly FormKey _topCellRef;
    private readonly FormKey _quest;
    private readonly FormKey _dialogTopic;

    public EmbeddedChildEditTests()
    {
        _modFolder = Directory.CreateTempSubdirectory("medit-embed-edit-").FullName;
        _gameDirectory = Directory.CreateTempSubdirectory("medit-embed-edit-game-").FullName;

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        // An interior cell carrying all four of Cell's embedded slots.
        var cell = new Cell(mod) { EditorID = "EmbedCell", WaterHeight = 10f };
        var temporaryRef = new PlacedObject(mod) { EditorID = "TempRef", Position = new P3Float(11f, 22f, 33f), Scale = 1f };
        var persistentRef = new PlacedObject(mod) { EditorID = "PersistRef", Position = new P3Float(1f, 2f, 3f), Scale = 4f };
        var navmesh = new NavigationMesh(mod) { EditorID = "EmbedNavmesh" };
        var landscape = new Landscape(mod) { EditorID = "EmbedLandscape" };
        cell.Temporary.Add(temporaryRef);
        cell.Persistent.Add(persistentRef);
        cell.NavigationMeshes.Add(navmesh);
        cell.Landscape = landscape;

        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        // The fifth slot: a worldspace's TopCell, which embeds into the worldspace's own document and
        // so has neither a file nor a directory anywhere in the tree.
        var worldspace = new Worldspace(mod) { EditorID = "EmbedWorld" };
        var topCell = new Cell(mod) { EditorID = "EmbedTopCell", WaterHeight = 5f };
        // A placed ref inside the TopCell: two embed levels down in one file (worldspace document →
        // TopCell → Temporary), with no file of its own anywhere. This is the shape #453's first cut
        // could not reach, because the embedded-child search stopped at one level.
        var topCellRef = new PlacedObject(mod) { EditorID = "TopCellRef", Position = new P3Float(7f, 8f, 9f), Scale = 6f };
        topCell.Temporary.Add(topCellRef);
        worldspace.TopCell = topCell;
        mod.Worldspaces.Add(worldspace);

        // A Quest with a dialog topic: the folder-split half of containment. The quest gets its own
        // directory and the topic a directory inside it, so a rename has to carry the child along —
        // and the embedded-child search must never descend into it (the topic has its own file, so an
        // edit written into the quest's document would be silently lost).
        var quest = new Quest(mod) { EditorID = "EmbedQuest" };
        var dialogTopic = new DialogTopic(mod) { EditorID = "EmbedTopic" };
        quest.DialogTopics.Add(dialogTopic);
        mod.Quests.Add(quest);

        mod.WriteToBinary(pluginPath);
        (_cell, _temporaryRef, _persistentRef) = (cell.FormKey, temporaryRef.FormKey, persistentRef.FormKey);
        (_navmesh, _landscape) = (navmesh.FormKey, landscape.FormKey);
        (_worldspace, _topCell, _topCellRef) = (worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);
        (_quest, _dialogTopic) = (quest.FormKey, dialogTopic.FormKey);

        _sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)_sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(PluginName, pluginPath, Origin, true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_sessions.Session!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _sessions.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    private RecordEditService EditService() =>
        new(_sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string SourceRoot => Path.Combine(_modFolder, $"{PluginName}{SourceRecordPath.SourceSuffix}");

    /// <summary>What the Source Control panel would show. AC3 says a refused edit leaves <i>the tree</i>
    /// untouched, so the refusal tests assert at that level rather than only at the index's — Track has
    /// just committed the complete pristine state, so an empty status is the honest positive control.</summary>
    private IReadOnlyList<string> GitStatus() =>
        GitCli.Run(Path.Combine(_modFolder, ".git"), _modFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

    /// <summary>The source file whose text contains <paramref name="editorId"/> — the test's own
    /// locator, walking the tree independently of <c>SourceUnitResolver</c> so it cannot agree with
    /// the code under test by construction.</summary>
    private string SourceFileContaining(string editorId) =>
        Directory.EnumerateFiles(SourceRoot, "RecordData.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    // ---- AC1: the parent's untouched bytes are untouched ----

    [Fact]
    public void EditingAnEmbeddedPlacedRefsField_RewritesOnlyThatFieldInTheOwningCellsFile()
    {
        var file = SourceFileContaining("EmbedCell");
        var before = File.ReadAllText(file);
        // Positive control for every Assert.Empty(GitStatus()) in the refusal tests below: Track has
        // just committed the pristine tree, so the status is empty now and must not be after an edit
        // that actually lands. Without this the emptiness assertions could pass for the wrong reason.
        Assert.Empty(GitStatus());

        var result = EditService().EditField(_plugin, _temporaryRef.ToString(), "scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(GitStatus());
        // AC1 in its strongest form: every byte outside the edited field's own text is identical.
        // The two placed refs carry distinct scales in the fixture precisely so this substitution
        // is unique — a shared value would make the assertion pass for an edit that hit both.
        Assert.Equal(before.Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal), File.ReadAllText(file));
    }

    [Fact]
    public void EditingAnEmbeddedChild_LeavesTheParentsOwnFieldsAlone()
    {
        var file = SourceFileContaining("EmbedCell");

        Assert.True(EditService().EditField(_plugin, _temporaryRef.ToString(), "scale", Json("7.0")).Applied);

        // The cell's own WaterHeight — a field of the parent, not of the child — is untouched, and so
        // is its EditorID. A read-modify-write that reserialized the parent from anything other than
        // its own text would be free to move these.
        var after = File.ReadAllText(file);
        Assert.Contains("\"WaterHeight\": 10.0", after, StringComparison.Ordinal);
        Assert.Contains("\"EditorID\": \"EmbedCell\"", after, StringComparison.Ordinal);
    }

    // ---- AC4: both rows move, and the parent reads dirty ----

    [Fact]
    public void AfterAnEmbeddedEdit_TheChildsOwnRowCarriesTheNewValue()
    {
        Assert.True(EditService().EditField(_plugin, _temporaryRef.ToString(), "scale", Json("3.5")).Applied);

        var child = _sessions.Index!.GetDocument(_temporaryRef.ToString(), _plugin);
        Assert.NotNull(child);
        Assert.Contains("\"Scale\": 3.5", child!.Body!, StringComparison.Ordinal);
    }

    [Fact]
    public void AfterAnEmbeddedEdit_TheOwningCellReadsDirtyAtEffective()
    {
        var index = _sessions.Index!;
        // Clean before: the tree is exactly what Track committed, so both refs agree.
        Assert.Equal(
            index.GetDocument(_cell.ToString(), _plugin)!.Body,
            index.At(RecordRef.Head).GetDocument(_cell.ToString(), _plugin)!.Body);

        Assert.True(EditService().EditField(_plugin, _temporaryRef.ToString(), "scale", Json("4.5")).Applied);

        // The parent is the source unit, so the parent is what went dirty — Effective has moved and
        // Head still holds what was committed. That is what makes the edit visible as a pending
        // change on the record the file actually belongs to.
        var effective = index.GetDocument(_cell.ToString(), _plugin)!.Body;
        var head = index.At(RecordRef.Head).GetDocument(_cell.ToString(), _plugin)!.Body;
        Assert.NotEqual(effective, head);
        Assert.Contains("\"Scale\": 4.5", effective!, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Scale\": 4.5", head!, StringComparison.Ordinal);
    }

    // ---- The index's spatial side tables stay correct, because nothing can move them ----

    [Fact]
    public void APlacedRefsPosition_IsNotAWritableField_SoItsPlacementRowCannotGoStale()
    {
        var index = _sessions.Index!;
        Assert.Equal(11f, index.GetPlacement(_temporaryRef.ToString(), _plugin)!.Value.PosX);

        var result = EditService().EditField(
            _plugin, _temporaryRef.ToString(), "position", Json("""{"X": 99.0, "Y": 88.0, "Z": 77.0}"""));

        // `placement`'s only non-containment columns come from Position, and Position is a P3Float,
        // which SchemaReflector.GetColumnInfo does not map — the property is dropped, so `refr` has no
        // `position` column and the write refuses. That is what makes the table unreachable from this
        // gesture, and it is why RecordEditService has no placement write-back: there would be nothing
        // able to make one go red.
        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal(11f, index.GetPlacement(_temporaryRef.ToString(), _plugin)!.Value.PosX);
        // AC3 at the level the AC names: no working-tree dirt at all from a refused edit.
        Assert.Empty(GitStatus());
    }

    [Fact]
    public void ACellsChildSlots_AreRefused_SoContainerChildCannotGoStale()
    {
        // Reflection makes these ordinary writable columns, and #453 is what first made a Cell
        // reachable through EditField at all. Writing one would swap a container's child set through a
        // JSON blob, leaving the replaced children with rows and parentage but no parent — silent index
        // corruption, not an edit.
        var service = EditService();

        var navmeshes = service.EditField(_plugin, _cell.ToString(), "navigation_meshes", Json("[]"));
        Assert.False(navmeshes.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, navmeshes.Refusal);
        Assert.Contains("461", navmeshes.Message, StringComparison.Ordinal);

        var landscape = service.EditField(_plugin, _cell.ToString(), "landscape", Json("null"));
        Assert.False(landscape.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, landscape.Refusal);

        var topCell = service.EditField(_plugin, _worldspace.ToString(), "top_cell", Json("null"));
        Assert.False(topCell.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, topCell.Refusal);

        // The child records are all still exactly where they were...
        Assert.Equal(_cell.ToString(), _sessions.Index!.GetContainerParent(_plugin, _navmesh.ToString())!.Value.ParentFormKey);
        Assert.Equal(_cell.ToString(), _sessions.Index!.GetContainerParent(_plugin, _landscape.ToString())!.Value.ParentFormKey);
        // ...and AC3's own claim, at the level it names: three refusals, not one byte of tree dirt.
        Assert.Empty(GitStatus());
    }

    [Fact]
    public void ACellsGrid_IsRefused_SoCellLocationCannotGoStale()
    {
        // An exterior cell's grid coordinates *are* its source directory, so moving them restructures
        // the tree rather than rewriting a file — and the same two numbers are mirrored in
        // cell_location, which nothing on the write path re-derives.
        var result = EditService().EditField(
            _plugin, _cell.ToString(), "grid", Json("""{"Point": {"X": 9, "Y": 9}}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("454", result.Message, StringComparison.Ordinal);
        Assert.Empty(GitStatus());
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

        Assert.True(service.EditField(_plugin, _persistentRef.ToString(), "scale", Json("2.0")).Applied);
        Assert.True(service.EditField(_plugin, _temporaryRef.ToString(), "scale", Json("3.0")).Applied);
        // TopCell is embedded in the *worldspace's* document, so its source unit is a different file
        // from the two above — the case that falls through a resolver built only for cells.
        Assert.True(service.EditField(_plugin, _topCell.ToString(), "water_height", Json("42.0")).Applied);

        var cellFile = File.ReadAllText(SourceFileContaining("EmbedCell"));
        Assert.Contains("\"Scale\": 2.0", cellFile, StringComparison.Ordinal);
        Assert.Contains("\"Scale\": 3.0", cellFile, StringComparison.Ordinal);

        // The top cell has no file of its own anywhere in the tree — that is what "embedded" means, and
        // it is why locating it by content finds the worldspace's own document.
        var worldspaceFile = SourceFileContaining("EmbedWorld");
        Assert.Contains("\"WaterHeight\": 42.0", File.ReadAllText(worldspaceFile), StringComparison.Ordinal);
        Assert.Equal(worldspaceFile, SourceFileContaining("EmbedTopCell"));
    }

    // ---- Finding 2: containment nests deeper than one level inside a single document ----

    [Fact]
    public void APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneFile()
    {
        // worldspace RecordData.json → TopCell (embedded) → Temporary[0] (embedded). The ref has no
        // file of its own and no directory of its own; the only bytes it exists in are the
        // worldspace's. A one-level search refused this with SourceUnitNotFound.
        var file = SourceFileContaining("EmbedWorld");
        var before = File.ReadAllText(file);

        var result = EditService().EditField(_plugin, _topCellRef.ToString(), "scale", Json("9.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace("\"Scale\": 6.0", "\"Scale\": 9.5", StringComparison.Ordinal),
            File.ReadAllText(file));
        Assert.Contains(
            "\"Scale\": 9.5",
            _sessions.Index!.GetDocument(_topCellRef.ToString(), _plugin)!.Body!,
            StringComparison.Ordinal);
    }

    [Fact]
    public void AQuestsDialogTopic_IsNotReachedThroughTheQuestsDocument()
    {
        // The bound on the descent, from the other side: a dialog topic is a child of the quest but is
        // folder-split, with its own RecordData.json. Editing it must land in *its* file, never in the
        // quest's — a search that descended into every child slot would write the change into the
        // quest's document and lose it, because compile and ingest read the topic's own file.
        var questFile = SourceFileContaining("EmbedQuest");
        var topicFile = SourceFileContaining("EmbedTopic");
        Assert.NotEqual(questFile, topicFile);

        var questBefore = File.ReadAllText(questFile);
        Assert.True(EditService().EditField(_plugin, _dialogTopic.ToString(), "editor_id", Json("\"RenamedTopic\"")).Applied);

        Assert.Equal(questBefore, File.ReadAllText(questFile));
        Assert.Contains(
            "\"EditorID\": \"RenamedTopic\"",
            File.ReadAllText(SourceFileContaining("RenamedTopic")),
            StringComparison.Ordinal);
    }

    // ---- Finding 3: SourceUnitNotFound, both branches ----

    [Fact]
    public void EditingARecordWhoseSourceDirectoryIsGone_RefusesAsSourceUnitNotFound()
    {
        // Branch one: the resolver finds no file and the index names no container that would hold it.
        // An interior cell removed from disk by something outside Modbench is exactly that.
        Directory.Delete(Path.GetDirectoryName(SourceFileContaining("EmbedCell"))!, recursive: true);

        var result = EditService().EditField(_plugin, _cell.ToString(), "water_height", Json("77.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, result.Refusal);
        Assert.Contains(_cell.ToString(), result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAnEmbeddedChildTheParentsTextNoLongerCarries_RefusesAsSourceUnitNotFound()
    {
        // Branch two: the resolver finds the parent's file, but the child is not inside it any more —
        // the index still has the placement row while the file has been edited out from under it.
        var file = SourceFileContaining("EmbedCell");
        var withoutTheRef = System.Text.RegularExpressions.Regex.Replace(
            File.ReadAllText(file), @"\s*\{[^{}]*""TempRef""[^{}]*\},?", "", System.Text.RegularExpressions.RegexOptions.Singleline);
        Assert.DoesNotContain("TempRef", withoutTheRef, StringComparison.Ordinal);
        File.WriteAllText(file, withoutTheRef);

        var result = EditService().EditField(_plugin, _temporaryRef.ToString(), "scale", Json("5.0"));

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
        var result = EditService().EditField(_plugin, _worldspace.ToString(), "sub_cells", Json("[]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("461", result.Message, StringComparison.Ordinal);
        Assert.Empty(GitStatus());
    }

    // ---- Finding 6: the container rename covers every directory-per-record type ----

    [Fact]
    public void EditingAWorldspacesEditorId_MovesItsSourceDirectory()
    {
        var oldDirectory = Path.GetDirectoryName(SourceFileContaining("EmbedWorld"))!;

        Assert.True(EditService().EditField(_plugin, _worldspace.ToString(), "editor_id", Json("\"RenamedWorld\"")).Applied);

        Assert.False(Directory.Exists(oldDirectory));
        Assert.Contains(
            "\"EditorID\": \"RenamedWorld\"",
            File.ReadAllText(SourceFileContaining("RenamedWorld")),
            StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAQuestsEditorId_MovesItsDirectory_AndItsFolderSplitChildrenTravelWithIt()
    {
        // The property the rename's doc comment claims and only a Quest can demonstrate: moving the
        // directory carries the folder-split children inside it, rather than orphaning them under a
        // directory that no longer exists.
        var oldDirectory = Path.GetDirectoryName(SourceFileContaining("EmbedQuest"))!;
        Assert.StartsWith(oldDirectory, SourceFileContaining("EmbedTopic"), StringComparison.Ordinal);

        Assert.True(EditService().EditField(_plugin, _quest.ToString(), "editor_id", Json("\"RenamedQuest\"")).Applied);

        Assert.False(Directory.Exists(oldDirectory));
        var newDirectory = Path.GetDirectoryName(SourceFileContaining("RenamedQuest"))!;
        // The dialog topic is still inside its quest, under the quest's new name.
        Assert.StartsWith(newDirectory, SourceFileContaining("EmbedTopic"), StringComparison.Ordinal);
    }
}
