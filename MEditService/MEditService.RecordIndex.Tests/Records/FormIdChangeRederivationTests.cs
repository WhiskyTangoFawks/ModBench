using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class FormIdChangeRederivationTests : IDisposable
{
    private readonly IndexedContainerMod _mod = new();
    private OpenedIndex Index => _mod.Index;

    public void Dispose() => _mod.Dispose();

    private IEnumerable<ChildRecordSummary> ChildrenOf(string cellKey)
    {
        var children = Index.Queries.GetCellChildRecords(_mod.Plugin, cellKey).Value();
        return children.Persistent.Concat(children.Temporary);
    }

    private string EmbeddedNavmeshKeyReadFromTheLiveChildRows =>
        ChildrenOf(_mod.EmbedCell).Single(c => c.RecordType == "navm").FormKey;

    private bool HoldsNavmesh(string cellKey, string navmeshKey) =>
        Index.Queries.GetCellChildRecords(_mod.Plugin, cellKey).Value().Temporary
            .Any(c => c.FormKey == navmeshKey && c.RecordType == "navm");

    private void ChangeFormIdWithATwoSidedPutAndRemoveThenNextCheck(string oldFormKey, string newFormKey, string newBody)
    {
        var repository = SourceMods.RepositoryOf(_mod.Entry);
        var current = Index.DocumentOf(oldFormKey, _mod.Plugin);
        repository.Put(_mod.Plugin, new SourceDocument(newFormKey, current.RecordType, current.EditorId, newBody)).Wrote();
        repository.Remove(_mod.Plugin, new RecordIdentity(oldFormKey, current.RecordType, current.EditorId)).Wrote();
        _mod.Index.NextCheck();
    }

    [Fact]
    public void ChangingTheFormIdOfAContainersOwnRecord_RepointsItsChildrensRows_AndTheOldKeyAnswersNothing()
    {
        var oldCellKey = _mod.EmbedCell;
        var navmesh = EmbeddedNavmeshKeyReadFromTheLiveChildRows;
        const string newCellKey = "F00010:ContainerFixture.esp";
        var before = _mod.Entry.SourceTextOf(Index.DocumentOf(oldCellKey, _mod.Plugin));
        var newBody = before.Replace(oldCellKey, newCellKey, StringComparison.Ordinal);
        Assert.NotEqual(before, newBody);

        ChangeFormIdWithATwoSidedPutAndRemoveThenNextCheck(oldCellKey, newCellKey, newBody);

        Assert.True(HoldsNavmesh(newCellKey, navmesh));
        Assert.Equal("temporary", Index.PlacementGroupIn(_mod.Plugin, newCellKey, _mod.TemporaryRef));

        Assert.Null(Index.CopyIn(oldCellKey, _mod.Plugin));
        Assert.Empty(ChildrenOf(oldCellKey));
    }

    [Fact]
    public void ChangingTheFormIdOfAnEmbeddedNavigationMesh_MovesItsChildRow_InFormIdOrderAmongItsCellsTemporaryChildren()
    {
        var cellKey = _mod.EmbedCell;
        var oldNavmeshKey = EmbeddedNavmeshKeyReadFromTheLiveChildRows;
        const string lowerNavmeshKey = "000001:ContainerFixture.esp";
        var document = Index.DocumentOf(cellKey, _mod.Plugin);

        Index.Edit(_mod.Entry, document, _mod.Entry.SourceTextOf(document).Replace(oldNavmeshKey, lowerNavmeshKey, StringComparison.Ordinal));

        Assert.Equal(lowerNavmeshKey, Index.Queries.GetCellChildRecords(_mod.Plugin, cellKey).Value().Temporary[0].FormKey);
        Assert.False(HoldsNavmesh(cellKey, oldNavmeshKey));
    }

    private static void RekeyTheWorldspace(OneExteriorCellWorldspaceFixture fixture, string newWorldspaceKey)
    {
        var current = fixture.Index.DocumentOf(fixture.Worldspace, fixture.Plugin);
        var repository = SourceMods.RepositoryOf(fixture.Entry);
        var identity = new RecordIdentity(fixture.Worldspace, current.RecordType, current.EditorId);
        repository.SaveChanges(repository.ChangesToRekey(fixture.Plugin, identity, newWorldspaceKey)).Wrote();
    }

    private static void RederiveTheWholePluginBecauseParentWorldspaceIsDerivedByWalkingTheWholeBlockTree(OneExteriorCellWorldspaceFixture fixture)
    {
        PluginBinaries.Touch(fixture.Entry.Path);
        fixture.Index.NextCheck();
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

    private sealed class OneExteriorCellWorldspaceFixture : IDisposable
    {
        private const string PluginName = "WorldspaceFormId.esp";
        private const string OriginNamingItsOwnModFolderBecauseInitAppliesToNothingElse = "WorldspaceFormIdMod";
        private readonly ScatteredFixtureData _fixture;

        public LoadOrderEntry Entry { get; }
        public PluginAddress Plugin => Entry.Key;
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
                }, origin: OriginNamingItsOwnModFolderBecauseInitAppliesToNothingElse)
                .BuildScattered()
                .CompiledPlugin();
            Entry = _fixture.Plugins.Single();
            (Worldspace, ExteriorCell) = (worldspace.ToString(), exteriorCell.ToString());
            Index = Indexes.Reconciled(_fixture);
        }

        public IEnumerable<string> CellsOf(string worldspace) =>
            Index.Queries.GetWorldspaceBlocks(Plugin, worldspace).Value().Blocks
                .SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells).Select(c => c.FormKey);

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }
}
