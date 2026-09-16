using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Records;

/// <summary>Asks <see cref="IRecordReads"/> directly rather than through a compile: these are
/// exactly the live load order reads that otherwise go stale before a reload.</summary>
public sealed class ContainmentRederivationTests : IDisposable
{
    private readonly IndexedContainerFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private ProjectingEditService EditService() => ProjectingEditService.Over(_fixture.Index, _fixture.Holder);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ---- delete a placed reference in a cell ----

    [Fact]
    public void DeletingAnEmbeddedPlacedReference_RemovesItsPlacementRow_SameLoadOrder()
    {
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
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
        var document = _fixture.Index.Projected().GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)
            ?? throw new InvalidOperationException($"Expected {_fixture.EmbedCell} to resolve to a document.");
        var body = document.Body
            ?? throw new InvalidOperationException($"Expected {_fixture.EmbedCell}'s document to carry a body.");
        return await codec.DeserializeFromBytesAsync(
            Encoding.UTF8.GetBytes(body), GameRelease.Fallout4, document.RecordType);
    }

    [Fact]
    public async Task DeletingAnEmbeddedNavigationMesh_RemovesItsContainerChildRow_ButLeavesItsSiblingIntact()
    {
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
        Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        Assert.True(ContainerChildFields.RemoveEmbeddedChild(owner, _fixture.Navmesh.ToString()));
        var newBody = await codec.SerializeToBytesAsync(owner, GameRelease.Fallout4);

        index.ProjectDocuments(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), Encoding.UTF8.GetString(newBody))]);

        Assert.Null(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString()),
            c => c.ChildFormKey == _fixture.Navmesh.ToString());
        // Landscape shares the same owner (EmbedCell) and the same delete-then-rebuild pass — a
        // rebuild that lost track of an untouched sibling in the same slot family must not pass.
        var landscapeParent = Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Landscape.ToString()));
        Assert.Equal(_fixture.EmbedCell.ToString(), landscapeParent.ParentFormKey);
    }

    // ---- renumber an embedded child ----

    [Fact]
    public async Task RenumberingAnEmbeddedNavigationMesh_MovesItsContainerChildRow_ToTheNewFormKey_WithTheSameSlot()
    {
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
        var before = Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        var found = Assert.NotNull(ContainerChildFields.FindEmbeddedChild(owner, _fixture.Navmesh.ToString()));
        var newFormKey = FormKey.Factory("F00001:ContainerFixture.esp");
        ((IMajorRecordInternal)found.Child).FormKey = newFormKey;

        // The renumber's whole file side: the owner's document is what carries the child's new
        // identity, and the projector re-reads the rows out of it (ADR-0014).
        await codec.SerializeAsync(
            owner, _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId), GameRelease.Fallout4);
        index.RefreshByKeys(_fixture.Plugin, _fixture.ModFolder, [_fixture.EmbedCell.ToString()]);

        // Old FormKey absent...
        Assert.Null(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Navmesh.ToString()));
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString()),
            c => c.ChildFormKey == _fixture.Navmesh.ToString());

        // ...new FormKey present, in the same slot, at the same index (the only NavigationMesh on
        // this cell, so its rank cannot have moved).
        var after = Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, newFormKey.ToString()));
        Assert.Equal(_fixture.EmbedCell.ToString(), after.ParentFormKey);
        Assert.Equal("NavigationMeshes", after.SlotName);
        Assert.Equal(before.SlotIndex, after.SlotIndex);
    }

    // ---- Recursion regression: a ref two levels inside a worldspace's own document ----

    [Fact]
    public void DeletingAPlacedRefTwoLevelsInsideAWorldspacesDocument_RemovesItsPlacementRow_AndKeepsTheTopCellsOwnCellLocationCorrect()
    {
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
        Assert.NotNull(index.At(RecordRef.Effective).GetPlacement(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        var topCellBefore = Assert.NotNull(index.At(RecordRef.Effective).GetCellLocation(_fixture.Plugin, _fixture.TopCell.ToString()));

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
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
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
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
        var before = Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Response.ToString()));
        Assert.Equal(_fixture.DialogTopic.ToString(), before.ParentFormKey);

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.DialogTopic.ToString());
        Assert.True(result.Applied, result.Message);
        Assert.NotEqual(_fixture.DialogTopic.ToString(), result.NewFormKey);

        // The response itself never moved, only its owning DialogTopic's identity changed, so its
        // container_child row must follow rather than vanish: a topic's children are its own accounting.
        var after = Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.Response.ToString()));
        Assert.Equal(result.NewFormKey, after.ParentFormKey);
        Assert.Equal(before.SlotName, after.SlotName);
        Assert.Equal(before.SlotIndex, after.SlotIndex);
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.DialogTopic.ToString()),
            c => c.ChildFormKey == _fixture.Response.ToString());
    }

    // ---- renumbering a container's own record updates its placed refs' placement rows ----

    [Fact]
    public void RenumberingAContainersOwnRecord_RepointsItsPlacedRefsPlacementRows_ToTheNewFormKey_SameLoadOrder()
    {
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
        var placementBefore = Assert.NotNull(index.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Equal(_fixture.EmbedCell.ToString(), placementBefore.ParentCell);

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());
        Assert.True(result.Applied, result.Message);
        Assert.NotEqual(_fixture.EmbedCell.ToString(), result.NewFormKey);
        var newFormKey = result.NewFormKey
            ?? throw new InvalidOperationException("Expected a successful renumber to set NewFormKey.");

        var placementAfter = Assert.NotNull(index.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Equal(newFormKey, placementAfter.ParentCell);
        Assert.Contains(
            index.At(RecordRef.Effective).GetCellReferences(_fixture.Plugin, newFormKey).Temporary,
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
        var newFormKey = result.NewFormKey
            ?? throw new InvalidOperationException("Expected a successful renumber to set NewFormKey.");

        var rows = _fixture.Index.Projected().GetContainerChildren(_fixture.Plugin, newFormKey)
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
        var holder = new LoadOrderHolder();
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("6.5")).Applied);
        var liveDocument = _fixture.Index.Projected().GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)
            ?? throw new InvalidOperationException($"Expected {_fixture.TemporaryRef} to resolve to a document.");
        var live = liveDocument.Body
            ?? throw new InvalidOperationException($"Expected {_fixture.TemporaryRef}'s document to carry a body.");
        Assert.Contains("\"Scale\": 6.5", live, StringComparison.Ordinal);

        using var reloaded = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        reloaded.Reconcile(holder,
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(reloaded.Status.Failures);

        var reloadedDocument = reloaded.Store.Require().At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)
            ?? throw new InvalidOperationException($"Expected {_fixture.TemporaryRef} to resolve to a document after reload.");
        Assert.Equal(reloadedDocument.Body, live);
    }

    [Fact]
    public void AfterRenumberingAContainersOwnRecord_AFreshReopen_AgreesWithTheLivePlacementRow()
    {
        var holder = new LoadOrderHolder();
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());
        Assert.True(result.Applied, result.Message);

        var live = _fixture.Index.Projected().GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);

        using var reloaded = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        reloaded.Reconcile(holder,
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(reloaded.Status.Failures);

        var freshlyIngested = reloaded.Store.Require().At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);

        Assert.Equal(freshlyIngested, live);
    }

    // ---- renumbering a Quest updates its DialogTopics' container_child rows ----

    [Fact]
    public void RenumberingAQuest_RepointsItsDialogTopicsContainerChildRows_ToTheNewParentFormKey_SameLoadOrder()
    {
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
        var before = Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.DialogTopic.ToString()));
        Assert.Equal(_fixture.Quest.ToString(), before.ParentFormKey);

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.True(result.Applied, result.Message);
        Assert.NotEqual(_fixture.Quest.ToString(), result.NewFormKey);

        var after = Assert.NotNull(index.At(RecordRef.Effective).GetContainerParent(_fixture.Plugin, _fixture.DialogTopic.ToString()));
        Assert.Equal(result.NewFormKey, after.ParentFormKey);
        Assert.Equal(before.SlotName, after.SlotName);
        Assert.Equal(before.SlotIndex, after.SlotIndex);
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString()),
            c => c.ChildFormKey == _fixture.DialogTopic.ToString());
    }

    [Fact]
    public void AfterRenumberingAQuest_AFreshReopen_AgreesWithTheLiveContainerChildRows()
    {
        var holder = new LoadOrderHolder();
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Quest.ToString());
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey
            ?? throw new InvalidOperationException("Expected a successful renumber to set NewFormKey.");

        var live = _fixture.Index.Projected().GetContainerChildren(_fixture.Plugin, newFormKey)
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        reloaded.Reconcile(holder,
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(reloaded.Status.Failures);

        var freshlyIngested = reloaded.Store.Require().At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, newFormKey)
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }

    // ---- a plain field edit re-derives containment rows unchanged ----

    [Fact]
    public void APlainFieldEdit_ReDerivesContainmentRowsIdentically_NoBehaviorChange()
    {
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
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
        var holder = new LoadOrderHolder();
        var deleted = EditService().DeleteRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var live = _fixture.Index.Projected().GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString())
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        reloaded.Reconcile(holder,
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(reloaded.Status.Failures);

        var freshlyIngested = reloaded.Store.Require().At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString())
            .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }

    [Fact]
    public async Task AfterRenumberingAnEmbeddedChild_AFreshReopen_AgreesWithTheLive()
    {
        var holder = new LoadOrderHolder();
        _fixture.Index.Settle();
        var index = _fixture.Index.Store.Require();
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var owner = await ReadEmbedCellAsync();
        var found = Assert.NotNull(ContainerChildFields.FindEmbeddedChild(owner, _fixture.Navmesh.ToString()));
        var newFormKey = FormKey.Factory("F00002:ContainerFixture.esp");
        ((IMajorRecordInternal)found.Child).FormKey = newFormKey;

        // The owner's source file is the whole of the renumber's file side, and a fresh reload
        // ingests that tree — so the live index has to reach the same rows from the same bytes.
        var cellFile = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        await codec.SerializeAsync(owner, cellFile, GameRelease.Fallout4);

        index.RefreshByKeys(_fixture.Plugin, _fixture.ModFolder, [_fixture.EmbedCell.ToString()]);

        var live = index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString())
            .OrderBy(c => c.SlotName).ThenBy(c => c.SlotIndex)
            .Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        using var reloaded = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        reloaded.Reconcile(holder,
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(reloaded.Status.Failures);

        var freshlyIngested = reloaded.Store.Require().At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.EmbedCell.ToString())
            .OrderBy(c => c.SlotName).ThenBy(c => c.SlotIndex)
            .Select(c => (c.ChildFormKey, c.SlotName, c.SlotIndex)).ToList();

        Assert.Equal(freshlyIngested, live);
    }
}
