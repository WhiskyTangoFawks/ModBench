using System.Text;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// #488: <c>placement</c>/<c>cell_location</c>/<c>container_child</c> now track Effective through a
/// structural write (delete, renumber, create) the same way <c>form_lookup</c>/<c>form_references</c>
/// already did — closing the gap <see cref="ContainerChildRow"/>'s own doc comment named. Runs against
/// <see cref="ContainerModFixture"/> (the same shared fixture <see cref="EmbeddedChildEditTests"/> and
/// <see cref="GroupOrderRenormalizationTests"/> use), asking the read side
/// (<see cref="IRecordReads"/>) directly rather than through a compile — these are exactly the
/// live-session reads the issue calls out as going stale before a reload.
/// </summary>
public sealed class ContainmentRederivationTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ---- AC1: delete a placed reference in a cell ----

    [Fact]
    public void DeletingAnEmbeddedPlacedReference_RemovesItsPlacementRow_SameSession()
    {
        var index = _fixture.Sessions.Index!;
        Assert.NotNull(index.GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Contains(
            index.GetCellReferences(_fixture.Plugin, _fixture.EmbedCell.ToString()).Temporary,
            p => p.FormKey == _fixture.TemporaryRef.ToString());

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.TemporaryRef.ToString());
        Assert.True(result.Applied, result.Message);

        Assert.Null(index.GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        var refs = index.GetCellReferences(_fixture.Plugin, _fixture.EmbedCell.ToString());
        Assert.DoesNotContain(refs.Temporary, p => p.FormKey == _fixture.TemporaryRef.ToString());
        // The sibling persistent ref survives untouched — a full rebuild of the cell's own placement
        // rows must not take an unrelated slot down with it.
        Assert.Contains(refs.Persistent, p => p.FormKey == _fixture.PersistentRef.ToString());
    }

    // ---- Mechanism 1 sanity: an embedded container_child-covered slot rebuilds on delete ----

    // NavigationMesh/Landscape have no schema at all (SchemaReflector publishes none for
    // land/navm/navi), so neither has a `records` row of its own and neither can be named directly
    // through RecordEditService.DeleteRecord/RenumberRecord, which both refuse "does not hold record"
    // the instant GetDocument comes back null — the same "nothing can exercise this through EditField"
    // limit EmbeddedChildEditTests documents for the identical reason. These two tests exercise the
    // index seam directly instead, doing exactly what RecordEditService's own embedded branch does:
    // read the owner, mutate the child inside its object graph, reserialize, and hand the new owner
    // body to ApplyWorkingTreeChanges/CreateWorkingTreeRecord — the container_child-covered sibling of
    // AC1's placed-ref case above, and AC2's own literal target ("an embedded child ... in
    // container_child").
    private async Task<IMajorRecord> ReadEmbedCellAsync()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var document = _fixture.Sessions.Index!.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!;
        return await codec.DeserializeFromBytesAsync(
            Encoding.UTF8.GetBytes(document.Body!), GameRelease.Fallout4, document.RecordType);
    }

    [Fact]
    public async Task DeletingAnEmbeddedNavigationMesh_RemovesItsContainerChildRow_ButLeavesItsSiblingIntact()
    {
        var index = _fixture.Sessions.Index!;
        Assert.NotNull(index.GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        Assert.True(ContainerChildFields.RemoveEmbeddedChild(owner, _fixture.Navmesh.ToString()));
        var newBody = await codec.SerializeToBytesAsync(owner, GameRelease.Fallout4);

        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), Encoding.UTF8.GetString(newBody))]);

        Assert.Null(index.GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.DoesNotContain(
            index.GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString()),
            c => c.ChildFormKey == _fixture.Navmesh.ToString());
        // Landscape shares the same owner (EmbedCell) and the same delete-then-rebuild pass — a
        // rebuild that lost track of an untouched sibling in the same slot family must not pass.
        Assert.Equal(
            _fixture.EmbedCell.ToString(),
            index.GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString())!.Value.ParentFormKey);
    }

    // ---- AC2: renumber an embedded child ----

    [Fact]
    public async Task RenumberingAnEmbeddedNavigationMesh_MovesItsContainerChildRow_ToTheNewFormKey_WithTheSameSlot()
    {
        var index = _fixture.Sessions.Index!;
        var before = index.GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString());
        Assert.NotNull(before);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        var found = ContainerChildFields.FindEmbeddedChild(owner, _fixture.Navmesh.ToString());
        Assert.NotNull(found);
        var newFormKey = FormKey.Factory("F00001:ContainerFixture.esp");
        ((IMajorRecordInternal)found!.Value.Child).FormKey = newFormKey;

        var newOwnerBody = await codec.SerializeToBytesAsync(owner, GameRelease.Fallout4);
        var newChildBody = await codec.SerializeToBytesAsync(found.Value.Child, GameRelease.Fallout4);

        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), Encoding.UTF8.GetString(newOwnerBody))]);
        index.CreateWorkingTreeRecord(
            _fixture.Plugin, newFormKey.ToString(), "navm", Encoding.UTF8.GetString(newChildBody));
        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.Navmesh.ToString(), null)]);

        // Old FormKey absent...
        Assert.Null(index.GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.DoesNotContain(
            index.GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString()),
            c => c.ChildFormKey == _fixture.Navmesh.ToString());

        // ...new FormKey present, in the same slot, at the same index (the only NavigationMesh on
        // this cell, so its rank cannot have moved).
        var after = index.GetContainerParent(_fixture.Plugin, newFormKey.ToString());
        Assert.NotNull(after);
        Assert.Equal(_fixture.EmbedCell.ToString(), after!.Value.ParentFormKey);
        Assert.Equal("NavigationMeshes", after.Value.SlotName);
        Assert.Equal(before!.Value.SlotIndex, after.Value.SlotIndex);
    }

    // ---- Recursion regression: a ref two levels inside a worldspace's own document ----

    [Fact]
    public void DeletingAPlacedRefTwoLevelsInsideAWorldspacesDocument_RemovesItsPlacementRow_AndKeepsTheTopCellsOwnCellLocationCorrect()
    {
        var index = _fixture.Sessions.Index!;
        Assert.NotNull(index.GetPlacement(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        var topCellBefore = index.GetCellLocation(_fixture.Plugin, _fixture.TopCell.ToString());
        Assert.NotNull(topCellBefore);

        // TopCellRef sits inside the *worldspace's* document (Worldspace -> TopCell -> Temporary),
        // two embed levels down (#453 finding 2's own fixture shape) — deleting it reserializes the
        // worldspace, and only a rebuild that recurses into the found TopCell reaches this ref's own
        // placement row at all. A rebuild that stops at the worldspace's immediate slots (TopCell
        // itself, never descending into it) would leave this row exactly as it was: present and
        // stale, not absent.
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.TopCellRef.ToString());
        Assert.True(result.Applied, result.Message);

        Assert.Null(index.GetPlacement(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        // The same recursive step also rebuilds the top cell's own cell_location row from scratch
        // (parent_worldspace/grid/isInterior) — unaffected by a sibling ref's deletion, so it must
        // come out identical to what it was.
        Assert.Equal(topCellBefore, index.GetCellLocation(_fixture.Plugin, _fixture.TopCell.ToString()));
    }

    // ---- AC3 (+ AC5's slot-reindex half): delete a folder-split container child ----

    [Fact]
    public void DeletingTheMiddleOfThreeDialogTopics_ReflectsTheRemoval_AndReindexesTheSurvivor_SameSession()
    {
        var index = _fixture.Sessions.Index!;
        var before = index.GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.Equal(
            [(_fixture.DialogTopic.ToString(), 0), (_fixture.DialogTopic2.ToString(), 1), (_fixture.DialogTopic3.ToString(), 2)],
            before.OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotIndex)));

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(result.Applied, result.Message);

        var after = index.GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.DoesNotContain(after, c => c.ChildFormKey == _fixture.DialogTopic2.ToString());
        // The survivor after the deleted slot renumbers down by one — exactly what
        // SourceUnitResolver.RenormalizeGroupOrder just did to its file name on disk.
        Assert.Equal(
            [(_fixture.DialogTopic.ToString(), 0), (_fixture.DialogTopic3.ToString(), 1)],
            after.OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotIndex)));
    }

    // ---- AC4: creating a record whose own body embeds children populates all three tables ----

    [Fact]
    public async Task CreatingAWorkingTreeRecord_WithEmbeddedChildren_PopulatesPlacementAndContainerChild()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("FreshCreate.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "FreshCell" };
        var placedRef = new PlacedObject(mod)
        {
            EditorID = "FreshPlacedRef",
            Position = new P3Float(1f, 2f, 3f),
        };
        var navMesh = new NavigationMesh(mod) { EditorID = "FreshNavMesh" };
        cell.Persistent.Add(placedRef);
        cell.NavigationMeshes.Add(navMesh);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var body = await codec.SerializeToBytesAsync(cell, GameRelease.Fallout4);

        using var repo = new DuckDbRecordIndex(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance), NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        // Seeds the `plugins` row CreateWorkingTreeRecord requires — an empty mod under the same key,
        // exactly what a session already holds before any create is possible.
        repo.Index(new Fallout4Mod(ModKey.FromFileName("FreshCreate.esp"), Fallout4Release.Fallout4),
            0, participates: true, new PluginKey("FreshCreate.esp", "Data"));

        var key = new PluginKey("FreshCreate.esp", "Data");
        repo.CreateWorkingTreeRecord(key, cell.FormKey.ToString(), "cell", Encoding.UTF8.GetString(body));

        // GetPlacement/GetContainerChildren read `placement`/`container_child` directly, unlike
        // GetCellReferences (which additionally joins against `records` for the placed ref's own row —
        // a separate row this isolated create, unlike a real embedded-child gesture, never asks for).
        var placement = repo.GetPlacement(placedRef.FormKey.ToString(), key);
        Assert.NotNull(placement);
        Assert.Equal(cell.FormKey.ToString(), placement!.Value.ParentCell);
        Assert.Equal(
            navMesh.FormKey.ToString(),
            Assert.Single(repo.GetContainerChildren(key, cell.FormKey.ToString())).ChildFormKey);
    }

    // ---- AC6: a plain field edit re-derives exactly as today ----

    [Fact]
    public void APlainFieldEdit_ReDerivesContainmentRowsIdentically_NoBehaviorChange()
    {
        var index = _fixture.Sessions.Index!;
        var placementBefore = index.GetPlacement(_fixture.PersistentRef.ToString(), _fixture.Plugin);
        var navmeshParentBefore = index.GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString());
        var landscapeParentBefore = index.GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString());

        // A field on the *owner* itself (not touching any child slot at all).
        Assert.True(EditService().EditField(_fixture.Plugin, _fixture.EmbedCell.ToString(), "water_height", Json("55.0")).Applied);

        Assert.Equal(placementBefore, index.GetPlacement(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.Equal(navmeshParentBefore, index.GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.Equal(landscapeParentBefore, index.GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString()));
    }

    // ---- AC5: parity against a fresh session-load ingest of the mutated tree ----

    [Fact]
    public void AfterDeletingAFolderSplitChild_AFreshSessionReload_AgreesWithTheLiveSession()
    {
        var deleted = EditService().DeleteRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var live = _fixture.Sessions.Index!.GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString())
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)reloaded).LoadExplicit(
            _fixture.GameDirectory,
            [new ExplicitPluginInput(
                ContainerModFixture.PluginName,
                Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName),
                ContainerModFixture.ModFolderOrigin,
                true)],
            GameRelease.Fallout4);
        Assert.Empty(((ISessionManager)reloaded).Session!.LoadFailures);

        var freshlyIngested = reloaded.Index!.GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString())
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }

    [Fact]
    public async Task AfterRenumberingAnEmbeddedChild_AFreshSessionReload_AgreesWithTheLiveSession()
    {
        var index = _fixture.Sessions.Index!;
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        var found = ContainerChildFields.FindEmbeddedChild(owner, _fixture.Navmesh.ToString());
        Assert.NotNull(found);
        var newFormKey = FormKey.Factory("F00002:ContainerFixture.esp");
        ((IMajorRecordInternal)found!.Value.Child).FormKey = newFormKey;

        var newOwnerBody = await codec.SerializeToBytesAsync(owner, GameRelease.Fallout4);
        var newChildBody = await codec.SerializeToBytesAsync(found.Value.Child, GameRelease.Fallout4);

        // Written to the owner's actual source file too (RecordEditService's own
        // RenumberEmbeddedChild does the same) — a fresh reload ingests the tree, not the live index.
        var cellFile = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        await codec.SerializeAsync(owner, cellFile, GameRelease.Fallout4);

        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), Encoding.UTF8.GetString(newOwnerBody))]);
        index.CreateWorkingTreeRecord(_fixture.Plugin, newFormKey.ToString(), "navm", Encoding.UTF8.GetString(newChildBody));
        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.Navmesh.ToString(), null)]);

        var live = index.GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString())
            .OrderBy(c => c.SlotName).ThenBy(c => c.SlotIndex)
            .Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)reloaded).LoadExplicit(
            _fixture.GameDirectory,
            [new ExplicitPluginInput(
                ContainerModFixture.PluginName,
                Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName),
                ContainerModFixture.ModFolderOrigin,
                true)],
            GameRelease.Fallout4);
        Assert.Empty(((ISessionManager)reloaded).Session!.LoadFailures);

        var freshlyIngested = reloaded.Index!.GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString())
            .OrderBy(c => c.SlotName).ThenBy(c => c.SlotIndex)
            .Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }
}
