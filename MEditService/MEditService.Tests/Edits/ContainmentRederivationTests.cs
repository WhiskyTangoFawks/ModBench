using System.Text;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>Asks <see cref="IRecordReads"/> directly rather than through a compile: these are
/// exactly the live load order reads that otherwise go stale before a reload.</summary>
public sealed class ContainmentRederivationTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ---- delete a placed reference in a cell ----

    [Fact]
    public void DeletingAnEmbeddedPlacedReference_RemovesItsPlacementRow_SameLoadOrder()
    {
        var index = _fixture.Mirror.Index!;
        Assert.NotNull(index.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Contains(
            index.At(RecordRef.Effective).GetCellReferences(_fixture.Plugin, _fixture.EmbedCell.ToString()).Temporary,
            p => p.FormKey == _fixture.TemporaryRef.ToString());

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.TemporaryRef.ToString());
        Assert.True(result.Applied, result.Message);

        Assert.Null(index.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        var refs = index.At(RecordRef.Effective).GetCellReferences(_fixture.Plugin, _fixture.EmbedCell.ToString());
        Assert.DoesNotContain(refs.Temporary, p => p.FormKey == _fixture.TemporaryRef.ToString());
        // The sibling persistent ref survives untouched — a full rebuild of the cell's own placement
        // rows must not take an unrelated slot down with it.
        Assert.Contains(refs.Persistent, p => p.FormKey == _fixture.PersistentRef.ToString());
    }

    // ---- an embedded container_child-covered slot rebuilds on delete ----

    // SchemaReflector publishes no schema for land/navm/navi, so neither record has a `records` row
    // and neither can be named through DeleteRecord/RenumberRecord: both refuse the instant
    // GetDocument comes back null.
    private async Task<IMajorRecord> ReadEmbedCellAsync()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var document = _fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!;
        return await codec.DeserializeFromBytesAsync(
            Encoding.UTF8.GetBytes(document.Body!), GameRelease.Fallout4, document.RecordType);
    }

    [Fact]
    public async Task DeletingAnEmbeddedNavigationMesh_RemovesItsContainerChildRow_ButLeavesItsSiblingIntact()
    {
        var index = _fixture.Mirror.Index!;
        Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        Assert.True(ContainerChildFields.RemoveEmbeddedChild(owner, _fixture.Navmesh.ToString()));
        var newBody = await codec.SerializeToBytesAsync(owner, GameRelease.Fallout4);

        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), Encoding.UTF8.GetString(newBody))]);

        Assert.Null(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString()),
            c => c.ChildFormKey == _fixture.Navmesh.ToString());
        // Landscape shares the same owner (EmbedCell) and the same delete-then-rebuild pass — a
        // rebuild that lost track of an untouched sibling in the same slot family must not pass.
        Assert.Equal(
            _fixture.EmbedCell.ToString(),
            index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString())!.Value.ParentFormKey);
    }

    // ---- renumber an embedded child ----

    [Fact]
    public async Task RenumberingAnEmbeddedNavigationMesh_MovesItsContainerChildRow_ToTheNewFormKey_WithTheSameSlot()
    {
        var index = _fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString());
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
        Assert.Null(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString()),
            c => c.ChildFormKey == _fixture.Navmesh.ToString());

        // ...new FormKey present, in the same slot, at the same index (the only NavigationMesh on
        // this cell, so its rank cannot have moved).
        var after = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, newFormKey.ToString());
        Assert.NotNull(after);
        Assert.Equal(_fixture.EmbedCell.ToString(), after!.Value.ParentFormKey);
        Assert.Equal("NavigationMeshes", after.Value.SlotName);
        Assert.Equal(before!.Value.SlotIndex, after.Value.SlotIndex);
    }

    // ---- Recursion regression: a ref two levels inside a worldspace's own document ----

    [Fact]
    public void DeletingAPlacedRefTwoLevelsInsideAWorldspacesDocument_RemovesItsPlacementRow_AndKeepsTheTopCellsOwnCellLocationCorrect()
    {
        var index = _fixture.Mirror.Index!;
        Assert.NotNull(index.At(RecordRef.Effective).GetPlacement(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        var topCellBefore = index.At(RecordRef.Effective).GetCellLocation(_fixture.Plugin, _fixture.TopCell.ToString());
        Assert.NotNull(topCellBefore);

        // TopCellRef sits two embed levels down inside the worldspace's document, so only a rebuild that
        // recurses into the found TopCell reaches its placement row; one stopping at the worldspace's
        // immediate slots would leave the row as it was.
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.TopCellRef.ToString());
        Assert.True(result.Applied, result.Message);

        Assert.Null(index.At(RecordRef.Effective).GetPlacement(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        // The same recursive step also rebuilds the top cell's own cell_location row from scratch
        // (parent_worldspace/grid/isInterior) — unaffected by a sibling ref's deletion, so it must
        // come out identical to what it was.
        Assert.Equal(topCellBefore, index.At(RecordRef.Effective).GetCellLocation(_fixture.Plugin, _fixture.TopCell.ToString()));
    }

    // ---- delete an embedded quest child (and slot-reindex the survivors) ----

    [Fact]
    public void DeletingTheMiddleOfThreeDialogTopics_ReflectsTheRemoval_AndReindexesTheSurvivor_SameLoadOrder()
    {
        var index = _fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.Equal(
            [(_fixture.DialogTopic.ToString(), 0), (_fixture.DialogTopic2.ToString(), 1), (_fixture.DialogTopic3.ToString(), 2)],
            before.Where(c => c.SlotName == "DialogTopics").OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotIndex)));

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(result.Applied, result.Message);

        var after = index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.DoesNotContain(after, c => c.ChildFormKey == _fixture.DialogTopic2.ToString());
        // The survivor after the deleted slot renumbers down by one: its row is re-derived from the
        // quest's document, whose DialogTopics array just closed up.
        Assert.Equal(
            [(_fixture.DialogTopic.ToString(), 0), (_fixture.DialogTopic3.ToString(), 1)],
            after.Where(c => c.SlotName == "DialogTopics").OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotIndex)));
    }

    // ---- Regression: renumbering an embedded container that itself owns embedded children ----

    [Fact]
    public void RenumberingADialogTopic_RepointsItsResponsesContainerChildRows_ToTheNewParentFormKey_SameLoadOrder()
    {
        var index = _fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Response.ToString());
        Assert.NotNull(before);
        Assert.Equal(_fixture.DialogTopic.ToString(), before!.Value.ParentFormKey);

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.DialogTopic.ToString());
        Assert.True(result.Applied, result.Message);
        Assert.NotEqual(_fixture.DialogTopic.ToString(), result.NewFormKey);

        // The response itself never moved, only its owning DialogTopic's identity changed, so its
        // container_child row must follow rather than vanish: a topic's children are its own accounting.
        var after = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Response.ToString());
        Assert.NotNull(after);
        Assert.Equal(result.NewFormKey, after!.Value.ParentFormKey);
        Assert.Equal(before.Value.SlotName, after.Value.SlotName);
        Assert.Equal(before.Value.SlotIndex, after.Value.SlotIndex);
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.DialogTopic.ToString()),
            c => c.ChildFormKey == _fixture.Response.ToString());
    }

    // ---- renumbering a container's own record updates its placed refs' placement rows ----

    [Fact]
    public void RenumberingAContainersOwnRecord_RepointsItsPlacedRefsPlacementRows_ToTheNewFormKey_SameLoadOrder()
    {
        var index = _fixture.Mirror.Index!;
        Assert.Equal(_fixture.EmbedCell.ToString(), index.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.Value.ParentCell);

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());
        Assert.True(result.Applied, result.Message);
        Assert.NotEqual(_fixture.EmbedCell.ToString(), result.NewFormKey);

        Assert.Equal(result.NewFormKey, index.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.Value.ParentCell);
        Assert.Contains(
            index.At(RecordRef.Effective).GetCellReferences(_fixture.Plugin, result.NewFormKey!).Temporary,
            p => p.FormKey == _fixture.TemporaryRef.ToString());
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetCellReferences(_fixture.Plugin, _fixture.EmbedCell.ToString()).Temporary,
            p => p.FormKey == _fixture.TemporaryRef.ToString());
    }

    [Fact]
    public void RenumberingAContainersOwnRecord_LeavesOneContainerChildRowPerEmbeddedChild()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());
        Assert.True(result.Applied, result.Message);

        var rows = _fixture.Mirror.Index!.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, result.NewFormKey!)
            .Select(c => (c.ChildFormKey, c.SlotName)).OrderBy(r => r.ChildFormKey, StringComparer.Ordinal).ToList();
        Assert.Equal(
            [(_fixture.Navmesh.ToString(), "NavigationMeshes"), (_fixture.Landscape.ToString(), "Landscape")],
            rows);
    }

    // The child's live document must be what a fresh ingest of the written tree reads: the index
    // derives it from the owner's document by the same codec ingest uses.
    [Fact]
    public void AfterAnEmbeddedFieldEdit_AFreshReopen_AgreesWithTheLiveChildDocument()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("6.5")).Applied);
        var live = _fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.Body;
        Assert.Contains("\"Scale\": 6.5", live!, StringComparison.Ordinal);

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.Failures);

        Assert.Equal(
            reloaded.Index!.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.Body,
            live);
    }

    [Fact]
    public void AfterRenumberingAContainersOwnRecord_AFreshReopen_AgreesWithTheLivePlacementRow()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());
        Assert.True(result.Applied, result.Message);

        var live = _fixture.Mirror.Index!.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.Failures);

        var freshlyIngested = reloaded.Index!.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);

        Assert.Equal(freshlyIngested, live);
    }

    // ---- renumbering a Quest updates its DialogTopics' container_child rows ----

    [Fact]
    public void RenumberingAQuest_RepointsItsDialogTopicsContainerChildRows_ToTheNewParentFormKey_SameLoadOrder()
    {
        var index = _fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.DialogTopic.ToString());
        Assert.NotNull(before);
        Assert.Equal(_fixture.Quest.ToString(), before!.Value.ParentFormKey);

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.True(result.Applied, result.Message);
        Assert.NotEqual(_fixture.Quest.ToString(), result.NewFormKey);

        var after = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.DialogTopic.ToString());
        Assert.NotNull(after);
        Assert.Equal(result.NewFormKey, after!.Value.ParentFormKey);
        Assert.Equal(before.Value.SlotName, after.Value.SlotName);
        Assert.Equal(before.Value.SlotIndex, after.Value.SlotIndex);
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString()),
            c => c.ChildFormKey == _fixture.DialogTopic.ToString());
    }

    [Fact]
    public void AfterRenumberingAQuest_AFreshReopen_AgreesWithTheLiveContainerChildRows()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;

        var live = _fixture.Mirror.Index!.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, newFormKey)
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.Failures);

        var freshlyIngested = reloaded.Index!.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, newFormKey)
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }

    // ---- creating a record whose own body embeds children populates all three tables ----

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
        // exactly what a load order already holds before any create is possible.
        repo.Index(new Fallout4Mod(ModKey.FromFileName("FreshCreate.esp"), Fallout4Release.Fallout4), Registration.Participating(0), new PluginKey("FreshCreate.esp", "Data"));

        var key = new PluginKey("FreshCreate.esp", "Data");
        repo.CreateWorkingTreeRecord(key, cell.FormKey.ToString(), "cell", Encoding.UTF8.GetString(body));

        // GetPlacement/GetContainerChildren read `placement`/`container_child` directly, unlike
        // GetCellReferences (which additionally joins against `records` for the placed ref's own row —
        // a separate row this isolated create, unlike a real embedded-child gesture, never asks for).
        var placement = repo.At(RecordRef.Effective).GetPlacement(placedRef.FormKey.ToString(), key);
        Assert.NotNull(placement);
        Assert.Equal(cell.FormKey.ToString(), placement!.Value.ParentCell);
        Assert.Equal(
            navMesh.FormKey.ToString(),
            Assert.Single(repo.At(RecordRef.Effective).GetContainerChildren(key, cell.FormKey.ToString())).ChildFormKey);
    }

    // ---- a plain field edit re-derives containment rows unchanged ----

    [Fact]
    public void APlainFieldEdit_ReDerivesContainmentRowsIdentically_NoBehaviorChange()
    {
        var index = _fixture.Mirror.Index!;
        var placementBefore = index.At(RecordRef.Effective).GetPlacement(_fixture.PersistentRef.ToString(), _fixture.Plugin);
        var navmeshParentBefore = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString());
        var landscapeParentBefore = index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString());

        // A field on the *owner* itself (not touching any child slot at all).
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.EmbedCell.ToString(), "WaterHeight", Json("55.0")).Applied);

        Assert.Equal(placementBefore, index.At(RecordRef.Effective).GetPlacement(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.Equal(navmeshParentBefore, index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.Equal(landscapeParentBefore, index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString()));
    }

    // ---- parity against a fresh reconcile ingest of the mutated tree ----

    [Fact]
    public void AfterDeletingAQuestChild_AFreshReopen_AgreesWithTheLive()
    {
        var deleted = EditService().DeleteRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var live = _fixture.Mirror.Index!.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString())
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.Failures);

        var freshlyIngested = reloaded.Index!.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString())
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }

    [Fact]
    public async Task AfterRenumberingAnEmbeddedChild_AFreshReopen_AgreesWithTheLive()
    {
        var index = _fixture.Mirror.Index!;
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        var found = ContainerChildFields.FindEmbeddedChild(owner, _fixture.Navmesh.ToString());
        Assert.NotNull(found);
        var newFormKey = FormKey.Factory("F00002:ContainerFixture.esp");
        ((IMajorRecordInternal)found!.Value.Child).FormKey = newFormKey;

        var newOwnerBody = await codec.SerializeToBytesAsync(owner, GameRelease.Fallout4);
        var newChildBody = await codec.SerializeToBytesAsync(found.Value.Child, GameRelease.Fallout4);

        // Written to the owner's actual source file too (RecordEditService's own
        // renumber's own embedded branch does the same) — a fresh reload ingests the tree, not the live index.
        var cellFile = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        await codec.SerializeAsync(owner, cellFile, GameRelease.Fallout4);

        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), Encoding.UTF8.GetString(newOwnerBody))]);
        index.CreateWorkingTreeRecord(_fixture.Plugin, newFormKey.ToString(), "navm", Encoding.UTF8.GetString(newChildBody));
        index.ApplyWorkingTreeChanges(_fixture.Plugin, [(_fixture.Navmesh.ToString(), null)]);

        var live = index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString())
            .OrderBy(c => c.SlotName).ThenBy(c => c.SlotIndex)
            .Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.Failures);

        var freshlyIngested = reloaded.Index!.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString())
            .OrderBy(c => c.SlotName).ThenBy(c => c.SlotIndex)
            .Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }
}
