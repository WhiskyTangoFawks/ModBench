using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

public sealed class FormIdChangeRederivationTests : IDisposable
{
    private readonly IndexedContainerMod _mod = new();
    private IRecordReads Reads => _mod.Reads;

    public void Dispose() => _mod.Dispose();

    private string EmbeddedNavmeshKeyReadFromTheLiveContainerChildRows =>
        Reads.GetContainerChildren(_mod.Plugin, _mod.EmbedCell).Single(c => c.SlotName == "NavigationMeshes").ChildFormKey;

    private void ChangeFormIdWithATwoSidedPutAndRemoveThenNextSnapshot(string oldFormKey, string newFormKey, string newBody)
    {
        var repository = TrackedMods.RepositoryOf(_mod.Entry);
        var current = Reads.DocumentOf(oldFormKey, _mod.Plugin);
        repository.Put(_mod.Plugin, new SourceDocument(newFormKey, current.RecordType, current.EditorId, newBody));
        repository.Remove(_mod.Plugin, new RecordIdentity(oldFormKey, current.RecordType, current.EditorId));
        _mod.Index.NextSnapshot();
    }

    [Fact]
    public void ChangingTheFormIdOfAContainersOwnRecord_RepointsItsChildrensRows_AndTheOldKeyAnswersNothing()
    {
        var oldCellKey = _mod.EmbedCell;
        var navmesh = EmbeddedNavmeshKeyReadFromTheLiveContainerChildRows;
        const string newCellKey = "F00010:ContainerFixture.esp";
        var before = Reads.DocumentOf(oldCellKey, _mod.Plugin).BodyOf();
        var newBody = before.Replace(oldCellKey, newCellKey, StringComparison.Ordinal);
        Assert.NotEqual(before, newBody);

        ChangeFormIdWithATwoSidedPutAndRemoveThenNextSnapshot(oldCellKey, newCellKey, newBody);

        Assert.Contains(Reads.GetContainerChildren(_mod.Plugin, newCellKey), c => c.ChildFormKey == navmesh);
        var navmeshParent = Assert.NotNull(Reads.GetContainerParent(_mod.Plugin, navmesh));
        Assert.Equal(newCellKey, navmeshParent.ParentFormKey);
        var placement = Assert.NotNull(Reads.GetPlacement(_mod.TemporaryRef, _mod.Plugin));
        Assert.Equal(newCellKey, placement.ParentCell);

        Assert.Null(Reads.GetDocument(oldCellKey, _mod.Plugin));
        Assert.Empty(Reads.GetContainerChildren(_mod.Plugin, oldCellKey));
    }

    [Fact]
    public void ChangingTheFormIdOfAnEmbeddedNavigationMesh_MovesItsContainerChildRow_ToTheNewFormKey_WithTheSameSlot()
    {
        var cellKey = _mod.EmbedCell;
        var oldNavmeshKey = EmbeddedNavmeshKeyReadFromTheLiveContainerChildRows;
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

    [Fact]
    public void ChangingTheFormIdOfAnEmbeddedNavigationMesh_WithoutTheNextSnapshotsValidation_LeavesTheStaleRowInPlace()
    {
        var cellKey = _mod.EmbedCell;
        var oldNavmeshKey = EmbeddedNavmeshKeyReadFromTheLiveContainerChildRows;
        const string newNavmeshKey = "F00012:ContainerFixture.esp";
        var document = Reads.DocumentOf(cellKey, _mod.Plugin);
        var newBody = document.BodyOf().Replace(oldNavmeshKey, newNavmeshKey, StringComparison.Ordinal);

        TrackedMods.RepositoryOf(_mod.Entry).Put(_mod.Plugin, new SourceDocument(cellKey, document.RecordType, document.EditorId, newBody));

        Assert.NotNull(Reads.GetContainerParent(_mod.Plugin, oldNavmeshKey));
        Assert.Null(Reads.GetContainerParent(_mod.Plugin, newNavmeshKey));
    }

    private static void RekeyTheWorldspace(OneExteriorCellWorldspaceFixture fixture, string newWorldspaceKey)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var current = fixture.Reads.DocumentOf(fixture.Worldspace, fixture.Plugin);
        var rekeying = new DocumentRekey(
            (document, newKey) => RecordDocumentEdits.WithFormKey(codec, document.Body, GameRelease.Fallout4, document.RecordType, newKey),
            (owner, oldKey, newKey) => RecordDocumentEdits.WithEmbeddedChildFormKey(
                codec, owner.Body, GameRelease.Fallout4, owner.RecordType, oldKey, newKey));
        new SourceRepository.SourceTransaction().Rekey(
            TrackedMods.RepositoryOf(fixture.Entry), fixture.Plugin,
            new RecordIdentity(fixture.Worldspace, current.RecordType, current.EditorId), newWorldspaceKey,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4), rekeying);
    }

    private static void RederiveTheWholePluginBecauseParentWorldspaceIsDerivedByWalkingTheWholeBlockTree(OneExteriorCellWorldspaceFixture fixture)
    {
        PluginBinaries.Touch(fixture.Entry.Path);
        fixture.Index.NextSnapshot();
    }

    [Fact]
    public async Task ChangingTheFormIdOfAWorldspace_RepointsItsExteriorCellsCellLocationRow_AndTheOldKeyAnswersNothing()
    {
        using var fixture = new OneExteriorCellWorldspaceFixture();
        var before = Assert.NotNull(fixture.Reads.GetCellLocation(fixture.Plugin, fixture.ExteriorCell));
        Assert.Equal(fixture.Worldspace, before.ParentWorldspace);
        const string newWorldspaceKey = "F00020:WorldspaceFormId.esp";

        RekeyTheWorldspace(fixture, newWorldspaceKey);
        RederiveTheWholePluginBecauseParentWorldspaceIsDerivedByWalkingTheWholeBlockTree(fixture);

        var after = Assert.NotNull(fixture.Reads.GetCellLocation(fixture.Plugin, fixture.ExteriorCell));
        Assert.Equal(newWorldspaceKey, after.ParentWorldspace);
        Assert.Contains(fixture.Reads.GetWorldspaceCells(fixture.Plugin, newWorldspaceKey), c => c.FormKey == fixture.ExteriorCell);
        Assert.Empty(fixture.Reads.GetWorldspaceCells(fixture.Plugin, fixture.Worldspace));
    }

    [Fact]
    public void ChangingTheFormIdOfAWorldspace_WithoutRevalidation_LeavesItsCellLocationRowStale()
    {
        using var fixture = new OneExteriorCellWorldspaceFixture();
        const string newWorldspaceKey = "F00021:WorldspaceFormId.esp";

        RekeyTheWorldspace(fixture, newWorldspaceKey);

        var stale = Assert.NotNull(fixture.Reads.GetCellLocation(fixture.Plugin, fixture.ExteriorCell));
        Assert.Equal(fixture.Worldspace, stale.ParentWorldspace);
    }

    private sealed class OneExteriorCellWorldspaceFixture : IDisposable
    {
        private const string PluginName = "WorldspaceFormId.esp";
        private const string OriginNamingItsOwnModFolderBecauseTrackAppliesToNothingElse = "WorldspaceFormIdMod";
        private readonly ScatteredFixtureData _fixture;

        public LoadOrderEntry Entry { get; }
        public PluginAddress Plugin => Entry.KeyOf();
        public OpenedIndex Index { get; }
        public IRecordReads Reads => Index.RequireReads();
        public string Worldspace { get; }
        public string ExteriorCell { get; }

        public OneExteriorCellWorldspaceFixture()
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
                }, origin: OriginNamingItsOwnModFolderBecauseTrackAppliesToNothingElse)
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
