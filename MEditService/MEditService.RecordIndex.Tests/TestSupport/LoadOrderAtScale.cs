using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>A load order of 100,000 rows, a thirtieth of LitR's, with cells as big as Prydwen's hull: enough that a
/// query per record touched runs 30 times slower than a query per operation.</summary>
internal sealed class LoadOrderAtScale : IDisposable
{
    private const int Rows = 100_000;
    private const int ReferencesInABigCell = 4_000;

    private readonly ScatteredFixtureData _fixture;

    internal OpenedIndex Index { get; private set; }

    internal LoadOrderEntry BigCellPlugin { get; }
    internal string BigCell { get; }
    internal string AReferenceInTheBigCell { get; }

    /// <summary>A source mod no commit holds the tree of, kept out of the load order until a test brings it in.</summary>
    internal LoadOrderEntry UncommittedPlugin { get; }
    internal string AReferenceInTheUncommittedCell { get; }

    internal LoadOrderAtScale(int plugins = 70)
    {
        string bigCell = "", aReference = "", anUncommittedReference = "";
        var builder = new PluginFixtureBuilder("at-scale");
        for (var p = 0; p < plugins; p++)
            builder.WithPlugin($"Plugin{p:D3}.esp", mod => AddCell(mod, $"Cell{p:D3}", Rows / plugins), origin: $"Mod{p:D3}");
        builder.WithPlugin("BigCell.esp", mod =>
        {
            var cell = AddCell(mod, "BigCell", ReferencesInABigCell);
            bigCell = cell.FormKey.ToString();
            aReference = cell.Temporary[ReferencesInABigCell / 2].FormKey.ToString();
        }, origin: "BigCellMod");
        builder.WithPlugin("Uncommitted.esp", mod =>
            anUncommittedReference = AddCell(mod, "UncommittedCell", ReferencesInABigCell).Temporary[0].FormKey.ToString(),
            origin: "UncommittedMod");
        _fixture = builder.BuildScattered();

        BigCellPlugin = _fixture.Plugins.Single(p => p.Name == "BigCell.esp");
        BigCell = bigCell;
        AReferenceInTheBigCell = aReference;
        SourceMods.Init(BigCellPlugin);

        UncommittedPlugin = _fixture.Plugins.Single(p => p.Name == "Uncommitted.esp");
        AReferenceInTheUncommittedCell = anUncommittedReference;
        SourceMods.Init(UncommittedPlugin);
        UncommittedPlugin.Git("rm", "-r", "-q", "--cached", PluginSourceRoot.For(UncommittedPlugin.Name).Replace('\\', '/'));
        UncommittedPlugin.Git("commit", "-q", "-m", "The tree untracked");

        Index = Launch();
    }

    internal void Close() => Index.Dispose();

    internal void Relaunch() => Index = Launch();

    private OpenedIndex Launch()
    {
        var holder = new LoadOrderHolder();
        var index = Indexes.Open(holder);
        index.Receive(holder, LoadOrder());
        return index;
    }

    internal LoadOrderSnapshot LoadOrder(params LoadOrderEntry[] added) =>
        SnapshotPlugins.Snapshot(
            _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [.. _fixture.Plugins.Where(p => p != UncommittedPlugin), .. added]);

    private static Cell AddCell(Fallout4Mod mod, string editorId, int references)
    {
        var placed = new Static(mod) { EditorID = $"{editorId}Base" };
        mod.Statics.Add(placed);
        var cell = new Cell(mod) { EditorID = editorId };
        for (var r = 0; r < references; r++)
        {
            var reference = new PlacedObject(mod) { EditorID = $"{editorId}Ref{r:D4}", Position = new Noggog.P3Float(r, 0, 0) };
            reference.Base.SetTo(placed);
            cell.Temporary.Add(reference);
        }
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
        return cell;
    }

    public void Dispose()
    {
        Index.Dispose();
        _fixture.Dispose();
    }
}
