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
    private const int RecordsOverridden = 1_500;

    private readonly ScatteredFixtureData _fixture;

    internal OpenedIndex Index { get; private set; }

    internal LoadOrderEntry BigCellPlugin { get; }
    internal string BigCell { get; }
    internal string AReferenceInTheBigCell { get; }

    /// <summary>A record every ordinary plugin holds a copy of.</summary>
    internal string AnOverriddenRecord { get; }
    internal IEnumerable<LoadOrderEntry> PluginsHoldingTheOverriddenRecord => _fixture.Plugins.Where(p => p.Name.StartsWith("Plugin", StringComparison.Ordinal));

    /// <summary>A plugin overriding about as many records of its master as Prydwen overrides of Fallout4.esm.</summary>
    internal PluginAddress OverridingPlugin { get; }
    internal IReadOnlyList<string> RecordsTheOverridingPluginOverrides { get; }

    /// <summary>A source mod no commit holds the tree of, kept out of the load order until a test brings it in.</summary>
    internal LoadOrderEntry UncommittedPlugin { get; }
    internal string AReferenceInTheUncommittedCell { get; }

    internal LoadOrderAtScale(int plugins = 70, int rows = Rows, int referencesInABigCell = ReferencesInABigCell)
    {
        string bigCell = "", aReference = "", anUncommittedReference = "", overridden = "";
        List<string> manyOverridden = [];
        var builder = new PluginFixtureBuilder("at-scale");
        for (var p = 0; p < plugins; p++)
            builder.WithPlugin($"Plugin{p:D3}.esp", (mod, masters) =>
            {
                AddCell(mod, $"Cell{p:D3}", rows / plugins);
                if (masters.Count == 0)
                {
                    var keyword = new Keyword(mod) { EditorID = "SharedKeyword" };
                    mod.Keywords.Add(keyword);
                    mod.Npcs.Add(new Npc(mod) { EditorID = "Shared", Keywords = [keyword.ToLink()] });
                    overridden = mod.Npcs.First().FormKey.ToString();
                }
                else mod.Npcs.GetOrAddAsOverride(masters[0].Npcs.First());
            }, origin: $"Mod{p:D3}");
        builder.WithPlugin("ManyBase.esp", mod =>
        {
            for (var r = 0; r < RecordsOverridden; r++)
            {
                var keyword = new Keyword(mod) { EditorID = $"Many{r:D4}" };
                mod.Keywords.Add(keyword);
                manyOverridden.Add(keyword.FormKey.ToString());
            }
        }, origin: "ManyBaseMod");
        builder.WithPlugin("ManyOverride.esp", (mod, masters) =>
        {
            foreach (var keyword in masters.Single(m => m.ModKey.FileName == "ManyBase.esp").Keywords)
                mod.Keywords.GetOrAddAsOverride(keyword);
        }, origin: "ManyOverrideMod");
        builder.WithPlugin("BigCell.esp", mod =>
        {
            var cell = AddCell(mod, "BigCell", referencesInABigCell);
            bigCell = cell.FormKey.ToString();
            aReference = cell.Temporary[referencesInABigCell / 2].FormKey.ToString();
        }, origin: "BigCellMod");
        builder.WithPlugin("Uncommitted.esp", mod =>
            anUncommittedReference = AddCell(mod, "UncommittedCell", referencesInABigCell).Temporary[0].FormKey.ToString(),
            origin: "UncommittedMod");
        _fixture = builder.BuildScattered();

        AnOverriddenRecord = overridden;
        OverridingPlugin = _fixture.Plugins.Single(p => p.Name == "ManyOverride.esp").Key;
        RecordsTheOverridingPluginOverrides = manyOverridden;
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
