using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

public sealed class FormIdChangeRederivationTests : IDisposable
{
    private readonly IndexedContainerMod _mod = new();
    private OpenedIndex Index => _mod.Index;

    public void Dispose() => _mod.Dispose();

    private IEnumerable<ChildRecordSummary> ChildrenOf(string cellKey)
    {
        var children = Index.Worldspaces.GetCellChildRecords(_mod.Plugin, cellKey);
        return children.Persistent.Concat(children.Temporary);
    }

    private string EmbeddedNavmeshKeyReadFromTheLiveChildRows =>
        ChildrenOf(_mod.EmbedCell).Single(c => c.RecordType == "navm").FormKey;

    private bool HoldsNavmesh(string cellKey, string navmeshKey) =>
        Index.Worldspaces.GetCellChildRecords(_mod.Plugin, cellKey).Temporary
            .Any(c => c.FormKey == navmeshKey && c.RecordType == "navm");

    private void ChangeFormIdWithATwoSidedPutAndRemoveThenNextSnapshot(string oldFormKey, string newFormKey, string newBody)
    {
        var repository = TrackedMods.RepositoryOf(_mod.Entry);
        var current = Index.DocumentOf(oldFormKey, _mod.Plugin);
        repository.Put(_mod.Plugin, new SourceDocument(newFormKey, current.RecordType, current.EditorId, newBody));
        repository.Remove(_mod.Plugin, new RecordIdentity(oldFormKey, current.RecordType, current.EditorId));
        _mod.Index.NextSnapshot();
    }

    [Fact]
    public void ChangingTheFormIdOfAContainersOwnRecord_RepointsItsChildrensRows_AndTheOldKeyAnswersNothing()
    {
        var oldCellKey = _mod.EmbedCell;
        var navmesh = EmbeddedNavmeshKeyReadFromTheLiveChildRows;
        const string newCellKey = "F00010:ContainerFixture.esp";
        var before = Index.BodyOf(oldCellKey, _mod.Plugin);
        var newBody = before.Replace(oldCellKey, newCellKey, StringComparison.Ordinal);
        Assert.NotEqual(before, newBody);

        ChangeFormIdWithATwoSidedPutAndRemoveThenNextSnapshot(oldCellKey, newCellKey, newBody);

        Assert.True(HoldsNavmesh(newCellKey, navmesh));
        Assert.Equal("temporary", Index.PlacementGroupIn(_mod.Plugin, newCellKey, _mod.TemporaryRef));

        Assert.Null(Index.CopyIn(oldCellKey, _mod.Plugin));
        Assert.Empty(ChildrenOf(oldCellKey));
    }

    [Fact]
    public void ChangingTheFormIdOfAnEmbeddedNavigationMesh_MovesItsChildRow_ToTheNewFormKey()
    {
        var cellKey = _mod.EmbedCell;
        var oldNavmeshKey = EmbeddedNavmeshKeyReadFromTheLiveChildRows;
        const string newNavmeshKey = "F00011:ContainerFixture.esp";
        var document = Index.DocumentOf(cellKey, _mod.Plugin);
        var before = Index.BodyOf(cellKey, _mod.Plugin);
        var newBody = before.Replace(oldNavmeshKey, newNavmeshKey, StringComparison.Ordinal);
        Assert.NotEqual(before, newBody);

        Index.Edit(_mod.Entry, document, newBody);

        Assert.False(HoldsNavmesh(cellKey, oldNavmeshKey));
        Assert.True(HoldsNavmesh(cellKey, newNavmeshKey));
    }

    [Fact]
    public void ChangingTheFormIdOfAnEmbeddedNavigationMesh_WithoutTheNextSnapshotsValidation_LeavesTheStaleRowInPlace()
    {
        var cellKey = _mod.EmbedCell;
        var oldNavmeshKey = EmbeddedNavmeshKeyReadFromTheLiveChildRows;
        const string newNavmeshKey = "F00012:ContainerFixture.esp";
        var document = Index.DocumentOf(cellKey, _mod.Plugin);
        var newBody = Index.BodyOf(cellKey, _mod.Plugin).Replace(oldNavmeshKey, newNavmeshKey, StringComparison.Ordinal);

        TrackedMods.RepositoryOf(_mod.Entry).Put(_mod.Plugin, new SourceDocument(cellKey, document.RecordType, document.EditorId, newBody));

        Assert.True(HoldsNavmesh(cellKey, oldNavmeshKey));
        Assert.False(HoldsNavmesh(cellKey, newNavmeshKey));
    }

    private static void RekeyTheWorldspace(OneExteriorCellWorldspaceFixture fixture, string newWorldspaceKey)
    {
        var current = fixture.Index.DocumentOf(fixture.Worldspace, fixture.Plugin);
        var rekeying = new DocumentRekey(
            (document, newKey) => RecordDocumentEdits.WithFormKey(document.Body, GameRelease.Fallout4, document.RecordType, newKey),
            (owner, oldKey, newKey) => RecordDocumentEdits.WithEmbeddedChildFormKey(
                owner.Body, GameRelease.Fallout4, owner.RecordType, oldKey, newKey));
        var repository = TrackedMods.RepositoryOf(fixture.Entry);
        var identity = new RecordIdentity(fixture.Worldspace, current.RecordType, current.EditorId);
        var carrying = repository.RecordOf(fixture.Plugin, identity).Require();
        SourceTransaction.Atomically(repository, transaction => transaction.Apply(
            repository.ChangesToRekey(fixture.Plugin, carrying, identity, newWorldspaceKey, rekeying)));
    }

    private static void RederiveTheWholePluginBecauseParentWorldspaceIsDerivedByWalkingTheWholeBlockTree(OneExteriorCellWorldspaceFixture fixture)
    {
        PluginBinaries.Touch(fixture.Entry.Path);
        fixture.Index.NextSnapshot();
    }

    [Fact]
    public void ChangingTheFormIdOfAWorldspace_MovesItsExteriorCell_AndTheOldKeyAnswersNothing()
    {
        using var fixture = new OneExteriorCellWorldspaceFixture();
        Assert.Equal([fixture.ExteriorCell], fixture.CellsOf(fixture.Worldspace));
        const string newWorldspaceKey = "F00020:WorldspaceFormId.esp";

        RekeyTheWorldspace(fixture, newWorldspaceKey);
        RederiveTheWholePluginBecauseParentWorldspaceIsDerivedByWalkingTheWholeBlockTree(fixture);

        Assert.Equal([fixture.ExteriorCell], fixture.CellsOf(newWorldspaceKey));
        Assert.Empty(fixture.CellsOf(fixture.Worldspace));
    }

    [Fact]
    public void ChangingTheFormIdOfAWorldspace_WithoutRevalidation_LeavesItsExteriorCellUnderTheOldKey()
    {
        using var fixture = new OneExteriorCellWorldspaceFixture();
        const string newWorldspaceKey = "F00021:WorldspaceFormId.esp";

        RekeyTheWorldspace(fixture, newWorldspaceKey);

        Assert.Equal([fixture.ExteriorCell], fixture.CellsOf(fixture.Worldspace));
        Assert.Empty(fixture.CellsOf(newWorldspaceKey));
    }

    private sealed class OneExteriorCellWorldspaceFixture : IDisposable
    {
        private const string PluginName = "WorldspaceFormId.esp";
        private const string OriginNamingItsOwnModFolderBecauseTrackAppliesToNothingElse = "WorldspaceFormIdMod";
        private readonly ScatteredFixtureData _fixture;

        public LoadOrderEntry Entry { get; }
        public PluginAddress Plugin => Entry.KeyOf();
        public OpenedIndex Index { get; }
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

        public IEnumerable<string> CellsOf(string worldspace) =>
            Index.Worldspaces.GetWorldspaceBlocks(Plugin, worldspace).Blocks
                .SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells).Select(c => c.FormKey);

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }
}
