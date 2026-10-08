using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginRecordLookupCellsTests
{
    private const string PluginName = "Cells.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    [Fact]
    public void CellsIn_AWorldspace_ListsItsPersistentCellAndEveryNumberedCellAcrossBlocks_AndNoOtherCell()
    {
        FormKey worldspaceKey = default;
        List<FormKey> expected = [];
        using var data = new PluginFixtureBuilder("lookup-cells")
            .WithPlugin(PluginName, mod =>
            {
                var worldspace = new Worldspace(mod) { EditorID = "World" };
                var persistent = new Cell(mod) { EditorID = "Persistent" };
                worldspace.TopCell = persistent;
                var near = ExteriorCell(mod, "Near", 1, -2);
                var far = ExteriorCell(mod, "Far", 170, 42);
                worldspace.SubCells.Add(Block(0, -1, 0, -1, near));
                worldspace.SubCells.Add(Block(5, 1, 21, 5, far));
                mod.Worldspaces.Add(worldspace);

                var other = new Worldspace(mod) { EditorID = "Other" };
                other.SubCells.Add(Block(0, 0, 0, 0, ExteriorCell(mod, "Elsewhere", 1, 1)));
                mod.Worldspaces.Add(other);

                var interior = new Cell(mod) { EditorID = "Interior" };
                var interiorSub = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
                interiorSub.Cells.Add(interior);
                var interiorBlock = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
                interiorBlock.SubBlocks.Add(interiorSub);
                mod.Cells.Records.Add(interiorBlock);

                worldspaceKey = worldspace.FormKey;
                expected = [persistent.FormKey, near.FormKey, far.FormKey];
            })
            .Build();

        using var lookup = Adapter.OpenRecordLookup(
            new RegisteredPlugin(PluginName, PluginOrigin.DataDirectory, Path.Combine(data.DataFolder, PluginName), PluginProvider.Game),
            GameRelease.Fallout4, new Dictionary<string, RecordTableSchema>());

        Assert.Equal(
            expected.Select(key => key.ToString()).Order(StringComparer.Ordinal),
            lookup.CellsIn(worldspaceKey.ToString()).Order(StringComparer.Ordinal));
        Assert.Empty(lookup.CellsIn(new FormKey(ModKey.FromFileName(PluginName), 0xFFFFFF).ToString()));
    }

    private static Cell ExteriorCell(Fallout4Mod mod, string editorId, int x, int y) =>
        new(mod) { EditorID = editorId, Grid = new CellGrid { Point = new P2Int(x, y) } };

    private static WorldspaceBlock Block(short blockX, short blockY, short subX, short subY, Cell cell)
    {
        var subBlock = new WorldspaceSubBlock { BlockNumberX = subX, BlockNumberY = subY };
        subBlock.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = blockX, BlockNumberY = blockY };
        block.Items.Add(subBlock);
        return block;
    }
}
