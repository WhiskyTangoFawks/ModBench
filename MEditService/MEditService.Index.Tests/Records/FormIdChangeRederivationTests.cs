using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

/// <summary>A FormID edit writes trees and nothing else (ADR-0015 invariant 2): container_child, placement and
/// cell_location rows are the Index's own re-derivation, driven here through RefreshKeys and
/// ReindexPlugin, the write side's signals for it.</summary>
public sealed class FormIdChangeRederivationTests : IDisposable
{
    private readonly IndexedContainerMod _mod = new();
    private IRecordReads Reads => _mod.Reads;

    public void Dispose() => _mod.Dispose();

    // The container_child mechanism (navmesh/landscape), not the placement one (Temporary/Persistent
    // refs already answer through GetPlacement) — read off the live rows rather than adding a new
    // FormKey to the shared fixture.
    private string NavmeshKey =>
        Reads.GetContainerChildren(_mod.Plugin, _mod.EmbedCell).Single(c => c.SlotName == "NavigationMeshes").ChildFormKey;

    // A record's own document under a new FormKey: put the new key, remove the old, then name both keys to
    // RefreshKeys — the same two-sided write a real FormID edit makes.
    private void ChangeFormId(string oldFormKey, string newFormKey, string newBody)
    {
        var repository = TrackedMods.RepositoryOf(_mod.Entry);
        var current = Reads.DocumentOf(oldFormKey, _mod.Plugin);
        repository.Put(_mod.Plugin, new SourceDocument(newFormKey, current.RecordType, current.EditorId, newBody));
        repository.Remove(_mod.Plugin, new RecordIdentity(oldFormKey, current.RecordType, current.EditorId));
        _mod.Index.RefreshKeys(_mod.Plugin, [oldFormKey, newFormKey]);
    }

    [Fact]
    public void ChangingTheFormIdOfAContainersOwnRecord_RepointsItsChildrensRows_AndTheOldKeyAnswersNothing()
    {
        var oldCellKey = _mod.EmbedCell;
        var navmesh = NavmeshKey;
        const string newCellKey = "F00010:ContainerFixture.esp";
        var before = Reads.DocumentOf(oldCellKey, _mod.Plugin).BodyOf();
        var newBody = before.Replace(oldCellKey, newCellKey, StringComparison.Ordinal);
        Assert.NotEqual(before, newBody); // the fixture body really does carry the key being changed

        ChangeFormId(oldCellKey, newCellKey, newBody);

        // The container's own children follow it to the new key.
        Assert.Contains(Reads.GetContainerChildren(_mod.Plugin, newCellKey), c => c.ChildFormKey == navmesh);
        var navmeshParent = Assert.NotNull(Reads.GetContainerParent(_mod.Plugin, navmesh));
        Assert.Equal(newCellKey, navmeshParent.ParentFormKey);
        var placement = Assert.NotNull(Reads.GetPlacement(_mod.TemporaryRef, _mod.Plugin));
        Assert.Equal(newCellKey, placement.ParentCell);

        // The old key answers nothing: no document, no children, no placement under it.
        Assert.Null(Reads.GetDocument(oldCellKey, _mod.Plugin));
        Assert.Empty(Reads.GetContainerChildren(_mod.Plugin, oldCellKey));
    }

    [Fact]
    public void ChangingTheFormIdOfAnEmbeddedNavigationMesh_MovesItsContainerChildRow_ToTheNewFormKey_WithTheSameSlot()
    {
        var cellKey = _mod.EmbedCell;
        var oldNavmeshKey = NavmeshKey;
        const string newNavmeshKey = "F00011:ContainerFixture.esp";
        var before = Assert.NotNull(Reads.GetContainerParent(_mod.Plugin, oldNavmeshKey));
        var document = Reads.DocumentOf(cellKey, _mod.Plugin);
        var newBody = document.BodyOf().Replace(oldNavmeshKey, newNavmeshKey, StringComparison.Ordinal);
        Assert.NotEqual(document.BodyOf(), newBody);

        _mod.Index.Edit(_mod.Entry, document, newBody);

        Assert.Null(Reads.GetContainerParent(_mod.Plugin, oldNavmeshKey));
        var after = Assert.NotNull(Reads.GetContainerParent(_mod.Plugin, newNavmeshKey));
        Assert.Equal(cellKey, after.ParentFormKey);
        Assert.Equal(before.SlotName, after.SlotName);
        Assert.Equal(before.SlotIndex, after.SlotIndex);
    }

    // The rival this pins for both tests above: without RefreshKeys naming the changed key, the
    // stale row from before the FormID edit is exactly what stays.
    [Fact]
    public void ChangingTheFormIdOfAnEmbeddedNavigationMesh_WithNoRefreshKeysCall_LeavesTheStaleRowInPlace()
    {
        var cellKey = _mod.EmbedCell;
        var oldNavmeshKey = NavmeshKey;
        const string newNavmeshKey = "F00012:ContainerFixture.esp";
        var document = Reads.DocumentOf(cellKey, _mod.Plugin);
        var newBody = document.BodyOf().Replace(oldNavmeshKey, newNavmeshKey, StringComparison.Ordinal);

        // Put only — the narrow signal RefreshKeys is, deliberately skipped.
        TrackedMods.RepositoryOf(_mod.Entry).Put(_mod.Plugin, new SourceDocument(cellKey, document.RecordType, document.EditorId, newBody));

        Assert.NotNull(Reads.GetContainerParent(_mod.Plugin, oldNavmeshKey));
        Assert.Null(Reads.GetContainerParent(_mod.Plugin, newNavmeshKey));
    }

    // A worldspace's exterior cell is a nested directory-per-record child (unlike a navmesh,
    // embedded inline): the FormID edit is SourceTransaction's public Move of the whole subtree, then
    // a Put fixing the moved document's own FormKey text.
    private static void ChangeWorldspaceFormId(WorldspaceFixture fixture, string newWorldspaceKey)
    {
        var repository = TrackedMods.RepositoryOf(fixture.Entry);
        var current = fixture.Reads.DocumentOf(fixture.Worldspace, fixture.Plugin);
        var oldIdentity = new RecordIdentity(fixture.Worldspace, current.RecordType, current.EditorId);
        var transaction = new SourceRepository.SourceTransaction();
        transaction.Move(repository, fixture.Plugin, oldIdentity, newWorldspaceKey);

        var newIdentity = new RecordIdentity(newWorldspaceKey, current.RecordType, current.EditorId);
        var moved = repository.Get(fixture.Plugin, newIdentity)
            ?? throw new InvalidOperationException("Expected the moved worldspace to resolve at its new identity.");
        var correctedBody = moved.Body.Replace(fixture.Worldspace, newWorldspaceKey, StringComparison.Ordinal);
        transaction.Put(repository, fixture.Plugin, new SourceDocument(newWorldspaceKey, current.RecordType, current.EditorId, correctedBody));
    }

    // cell_location.ParentWorldspace is derived by walking the whole Worldspaces/blocks/sub-blocks
    // tree top-down (SourceTreeDocuments), which RefreshKeys' narrow per-record re-parse does not
    // do; ReindexPlugin re-derives the plugin whole from source.
    [Fact]
    public async Task ChangingTheFormIdOfAWorldspace_RepointsItsExteriorCellsCellLocationRow_AndTheOldKeyAnswersNothing()
    {
        using var fixture = new WorldspaceFixture();
        var before = Assert.NotNull(fixture.Reads.GetCellLocation(fixture.Plugin, fixture.ExteriorCell));
        Assert.Equal(fixture.Worldspace, before.ParentWorldspace);
        const string newWorldspaceKey = "F00020:WorldspaceFormId.esp";

        ChangeWorldspaceFormId(fixture, newWorldspaceKey);
        PluginBinaries.Touch(fixture.Entry.Path);
        Assert.True(await fixture.Index.RefreshBinary(fixture.Plugin, fixture.Entry.Path));

        var after = Assert.NotNull(fixture.Reads.GetCellLocation(fixture.Plugin, fixture.ExteriorCell));
        Assert.Equal(newWorldspaceKey, after.ParentWorldspace);
        Assert.Contains(fixture.Reads.GetWorldspaceCells(fixture.Plugin, newWorldspaceKey), c => c.FormKey == fixture.ExteriorCell);
        Assert.Empty(fixture.Reads.GetWorldspaceCells(fixture.Plugin, fixture.Worldspace));
    }

    // The rival this pins: without ReindexPlugin (or an equivalent whole-plugin re-derivation), the
    // exterior cell's row is exactly the stale one from before the move.
    [Fact]
    public void ChangingTheFormIdOfAWorldspace_WithNoReindexCall_LeavesItsCellLocationRowStale()
    {
        using var fixture = new WorldspaceFixture();
        const string newWorldspaceKey = "F00021:WorldspaceFormId.esp";

        ChangeWorldspaceFormId(fixture, newWorldspaceKey);

        var stale = Assert.NotNull(fixture.Reads.GetCellLocation(fixture.Plugin, fixture.ExteriorCell));
        Assert.Equal(fixture.Worldspace, stale.ParentWorldspace);
    }

    // A worldspace with one exterior cell — the shape ContainerMod does not build (its own
    // worldspace holds only a top cell).
    private sealed class WorldspaceFixture : IDisposable
    {
        private const string PluginName = "WorldspaceFormId.esp";
        // Not the default Data origin: Track (and so a source tree to change a FormID against) only
        // applies to a plugin that names its own mod folder (LoadOrderSnapshot.ModFolderOf).
        private const string Origin = "WorldspaceFormIdMod";
        private readonly ScatteredFixtureData _fixture;

        public LoadOrderEntry Entry { get; }
        public PluginAddress Plugin => Entry.KeyOf();
        public Indexer Index { get; }
        public IRecordReads Reads => Index.RequireReads();
        public string Worldspace { get; }
        public string ExteriorCell { get; }

        public WorldspaceFixture()
        {
            FormKey worldspace = default, exteriorCell = default;
            _fixture = new PluginFixtureBuilder("worldspace-formid")
                .WithPlugin(PluginName, mod =>
                {
                    var world = new Worldspace(mod) { EditorID = "TestWorld" };
                    var ext = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(3, 4) } };
                    var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                    subBlock.Items.Add(ext);
                    var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                    block.Items.Add(subBlock);
                    world.SubCells.Add(block);
                    mod.Worldspaces.Add(world);
                    (worldspace, exteriorCell) = (world.FormKey, ext.FormKey);
                }, origin: Origin)
                .BuildScattered()
                .Tracked();
            Entry = _fixture.Plugins.Single();
            (Worldspace, ExteriorCell) = (worldspace.ToString(), exteriorCell.ToString());
            Index = Indexes.Reconciled(_fixture);
        }

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }
}
