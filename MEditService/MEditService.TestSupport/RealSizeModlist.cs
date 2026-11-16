using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.TestSupport;

/// <summary>A modlist of LitR's shape, every record generated: 705 plugin binaries, 252 with a source tree. The record
/// index reads it as it reads any modlist, so the index holds whatever the index derives.</summary>
public sealed class RealSizeModlist : IDisposable
{
    public const int Plugins = 705;
    public const int SourceTreePlugins = 252;
    public const int ReferencesInTheBigCell = 4_000;
    public const int ManyDocuments = 1_000;

    // LitR's records per plugin, by rank from the largest.
    private static readonly (int Rank, int Records)[] Sizes =
        [(0, 1_600_000), (1, 310_000), (3, 134_000), (11, 17_000), (70, 1_350), (176, 230), (352, 47), (528, 8), (634, 2), (704, 1)];

    // Set so the index holds LitR's 3.1M records, 18M references, 2.9M holdings and 6 GB of documents.
    private const int RecordsPerCell = 32;
    private const int ReferencesPerCell = 27;
    private const int CombinedMeshesPerCell = 110;
    private const int CellsPerNavmesh = 6;
    private const int CellsPerNpc = 6;
    private const int CellsPerQuest = 20;
    private const int TopicsPerQuest = 14;
    private const int InteriorEveryCells = 25;
    private const int LightRecordLimit = 2_000;

    // LitR's largest source tree is about its eighth largest plugin.
    private const int BigSourceRank = 7;

    // LitR's deepest conflict stack.
    private const int PluginsOverridingOneRecord = 230;

    private readonly RunFolder _folder;
    private readonly List<(FormKey Key, string EditorId)> _baseStatics = [];
    private readonly List<string> _manyDocuments = [];
    private string _recordManyPluginsOverride = "";
    private LoadOrderEntry? _uncommitted;

    public string InstanceRoot => _folder.Path;

    public string DataFolder => Path.Combine(InstanceRoot, "Data");

    public IReadOnlyList<LoadOrderEntry> LoadOrder { get; private set; } = [];

    /// <summary>The largest plugin, the master every other plugin names.</summary>
    public LoadOrderEntry Master => LoadOrder[0];

    public string MastersBigCell { get; private set; } = "";

    /// <summary>A plugin read from its source tree, holding a big cell and many records each a document of its own.</summary>
    public LoadOrderEntry BigSourcePlugin => LoadOrder[BigSourceRank];

    public string BigCell { get; private set; } = "";

    public string AReferenceInTheBigCell { get; private set; } = "";

    public IReadOnlyList<string> TheManyDocuments => _manyDocuments;

    /// <summary>The plugins of a few records each, read from their binaries.</summary>
    public IReadOnlyList<LoadOrderEntry> SmallBinaryPlugins => [.. LoadOrder.Where((_, rank) => rank > 400 && !IsSourceTree(rank))];

    /// <summary>A source mod no commit holds the tree of, kept out of the load order until a test brings it in.</summary>
    public LoadOrderEntry UncommittedPlugin => _uncommitted.Require();

    public string AReferenceInTheUncommittedCell { get; private set; } = "";

    public RealSizeModlist() => _folder = RunFolder.Written("medit-real-size", Write);

    public LoadOrderSnapshot Snapshot(params LoadOrderEntry[] added) =>
        SnapshotPlugins.Snapshot(DataFolder, InstanceRoot, GameRelease.Fallout4, [.. LoadOrder, .. added]);

    private void Write(string root)
    {
        List<LoadOrderEntry> loadOrder = [];
        for (var rank = 0; rank < Plugins; rank++)
        {
            var entry = Write(root, rank);
            if (IsSourceTree(rank)) PluginSources.Init(entry.Path, entry.Origin);
            loadOrder.Add(entry);
        }
        LoadOrder = loadOrder;
        _uncommitted = WriteUncommitted(root);
    }

    private static int RecordsOf(int rank)
    {
        var upper = Array.FindIndex(Sizes, size => size.Rank >= rank);
        if (Sizes[upper].Rank == rank) return Sizes[upper].Records;
        var (fromRank, from) = Sizes[upper - 1];
        var (toRank, to) = Sizes[upper];
        var along = (double)(rank - fromRank) / (toRank - fromRank);
        return (int)Math.Round(from * Math.Pow((double)to / from, along));
    }

    private static bool IsSourceTree(int rank) =>
        rank == BigSourceRank || (rank >= 150 && rank < 150 + 2 * (SourceTreePlugins - 1) && rank % 2 == 0);

    // 70 of LitR's 705 plugins are inactive.
    private static bool IsActive(int rank) => rank % 10 != 5;

    private LoadOrderEntry Write(string root, int rank)
    {
        var records = RecordsOf(rank);
        var name = rank == 0 ? "Base.esm" : $"Mod{rank:D3}.esp";
        var origin = rank == 0 ? PluginOrigin.DataDirectory : $"Mod{rank:D3}";
        var folder = rank == 0 ? Path.Combine(root, "Data") : Path.Combine(root, "mods", origin);
        Directory.CreateDirectory(folder);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        if (records <= LightRecordLimit && rank % 5 != 0) mod.ModHeader.Flags |= Fallout4ModHeader.HeaderFlag.Small;

        var left = records - (rank == 0 ? AddMastersBigCell(mod) : Override(mod, rank, records));
        if (rank == BigSourceRank) left -= AddBigCellAndManyDocuments(mod);
        if (left >= RecordsPerCell) left -= AddWorld(mod, left / RecordsPerCell, rank);
        for (var k = 0; k < left; k++) mod.Keywords.Add(new Keyword(mod) { EditorID = $"Keyword{rank:D3}x{k}" });

        var path = Path.Combine(folder, name);
        mod.WriteToBinary(path);
        return new LoadOrderEntry(name, path, origin, rank, IsActive(rank), Winning: true);
    }

    private int AddMastersBigCell(Fallout4Mod mod)
    {
        MastersBigCell = AddBigCell(mod, "MastersBigCell").FormKey.ToString();
        return 2 + ReferencesInTheBigCell;
    }

    private int AddBigCellAndManyDocuments(Fallout4Mod mod)
    {
        var cell = AddBigCell(mod, "BigCell");
        BigCell = cell.FormKey.ToString();
        AReferenceInTheBigCell = cell.Temporary[ReferencesInTheBigCell / 2].FormKey.ToString();
        for (var d = 0; d < ManyDocuments; d++)
        {
            var keyword = new Keyword(mod) { EditorID = $"Document{d:D4}" };
            mod.Keywords.Add(keyword);
            _manyDocuments.Add(keyword.FormKey.ToString());
        }
        return 2 + ReferencesInTheBigCell + ManyDocuments;
    }

    private static Cell AddBigCell(Fallout4Mod mod, string editorId)
    {
        var placed = new Static(mod) { EditorID = $"{editorId}Static" };
        mod.Statics.Add(placed);
        var cell = new Cell(mod) { EditorID = editorId };
        for (var r = 0; r < ReferencesInTheBigCell; r++)
        {
            var reference = new PlacedObject(mod) { EditorID = $"{editorId}Ref{r:D4}", Position = new P3Float(r, 0, 0) };
            reference.Base.SetTo(placed.FormKey);
            cell.Temporary.Add(reference);
        }
        mod.AddInteriorCells(cell);
        return cell;
    }

    private LoadOrderEntry WriteUncommitted(string root)
    {
        const string name = "Uncommitted.esp";
        var folder = Path.Combine(root, "mods", "Uncommitted");
        Directory.CreateDirectory(folder);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        AReferenceInTheUncommittedCell = AddBigCell(mod, "UncommittedCell").Temporary[0].FormKey.ToString();
        var path = Path.Combine(folder, name);
        mod.WriteToBinary(path);
        var entry = new LoadOrderEntry(name, path, "Uncommitted", Plugins, Enabled: true, Winning: true);
        PluginSources.Init(entry.Path, entry.Origin);
        var git = Path.Combine(folder, ".git");
        GitProbe.Run(git, folder, "rm", "-r", "-q", "--cached", PluginSourceRoot.For(name).Replace('\\', '/'));
        GitProbe.Run(git, folder, "commit", "-q", "-m", "The tree untracked");
        return entry;
    }

    private int Override(Fallout4Mod mod, int rank, int records)
    {
        // LitR overrides about one record in twenty.
        var overrides = Math.Max(1, records / 20);
        var made = 0;
        if (rank <= PluginsOverridingOneRecord)
        {
            mod.Npcs.Add(new Npc(FormKey.Factory(_recordManyPluginsOverride), Fallout4Release.Fallout4) { EditorID = "Overridden", ShortName = $"Mod{rank:D3}" });
            made++;
        }
        for (; made < overrides; made++)
        {
            var (key, editorId) = _baseStatics[(int)(((long)rank * 7_919 + (long)made * 104_729) % _baseStatics.Count)];
            mod.Statics.Add(new Static(key, Fallout4Release.Fallout4) { EditorID = editorId, Model = new Model { File = $"Generated\\Mod{rank:D3}\\{editorId}.nif" } });
        }
        return made;
    }

    private int AddWorld(Fallout4Mod mod, int cells, int rank)
    {
        var added = 0;
        var layer = new Layer(mod) { EditorID = $"Layer{rank:D3}" };
        mod.Layers.Add(layer);
        var swap = new MaterialSwap(mod) { EditorID = $"Swap{rank:D3}" };
        mod.MaterialSwaps.Add(swap);
        added += 2;

        var world = new Worldspace(mod) { EditorID = $"World{rank:D3}" };
        var side = (int)Math.Ceiling(Math.Sqrt(cells));
        var blocks = new Dictionary<(int, int), WorldspaceBlock>();
        var subBlocks = new Dictionary<(int, int), WorldspaceSubBlock>();
        List<Cell> interiors = [];
        var modelData = new Random(rank);
        for (var c = 0; c < cells; c++)
        {
            var placed = new Static(mod) { EditorID = $"Static{rank:D3}x{c}", Model = ModelOf($"Generated\\Mod{rank:D3}\\Static{c}.nif", modelData) };
            mod.Statics.Add(placed);
            if (rank == 0) _baseStatics.Add((placed.FormKey, placed.EditorID));
            var cell = new Cell(mod) { EditorID = $"Cell{rank:D3}x{c}" };
            for (var r = 0; r < ReferencesPerCell; r++)
            {
                var reference = new PlacedObject(mod) { Position = new P3Float(r * 128, c, 0), Rotation = new P3Float(0, 0, r) };
                reference.Base.SetTo(placed.FormKey);
                reference.Layer.SetTo(layer.FormKey);
                if (r % 2 == 1) reference.MaterialSwap.SetTo(swap.FormKey);
                if (r > 0 && r % 2 == 0) reference.EnableParent = new EnableParent { Reference = new FormLink<IPlacedGetter>(cell.Temporary[r - 1].FormKey) };
                cell.Temporary.Add(reference);
            }
            cell.CombinedMeshReferences = [.. Enumerable.Range(0, CombinedMeshesPerCell).Select(m => new CellCombinedMeshReference
            {
                Reference = new FormLink<IPlacedThingGetter>(cell.Temporary[m % ReferencesPerCell].FormKey), CombinedMesh = (uint)(c * CombinedMeshesPerCell + m),
            })];
            added += 2 + ReferencesPerCell;

            var interior = c % InteriorEveryCells == 0;
            if (c % CellsPerNavmesh == 0)
            {
                cell.NavigationMeshes.Add(Navmesh(mod, interior ? new CellNavmeshParent { Parent = new FormLink<ICellGetter>(cell.FormKey) } : new WorldspaceNavmeshParent { Parent = new FormLink<IWorldspaceGetter>(world.FormKey) }));
                added++;
            }
            if (interior)
            {
                interiors.Add(cell);
                continue;
            }

            var (x, y) = (c % side - side / 2, c / side - side / 2);
            cell.Grid = new CellGrid { Point = new P2Int(x, y) };
            if (c % 2 == 1)
            {
                cell.Landscape = Landscape(mod);
                added++;
            }
            var blockKey = (FloorDiv(x, 32), FloorDiv(y, 32));
            if (!blocks.TryGetValue(blockKey, out var block))
            {
                block = new WorldspaceBlock { BlockNumberX = (short)blockKey.Item1, BlockNumberY = (short)blockKey.Item2 };
                blocks[blockKey] = block;
                world.SubCells.Add(block);
            }
            var subKey = (FloorDiv(x, 8), FloorDiv(y, 8));
            if (!subBlocks.TryGetValue(subKey, out var subBlock))
            {
                subBlock = new WorldspaceSubBlock { BlockNumberX = (short)subKey.Item1, BlockNumberY = (short)subKey.Item2 };
                subBlocks[subKey] = subBlock;
                block.Items.Add(subBlock);
            }
            subBlock.Items.Add(cell);
        }
        if (blocks.Count > 0)
        {
            mod.Worldspaces.Add(world);
            added++;
        }
        if (interiors.Count > 0) mod.AddInteriorCells([.. interiors]);

        for (var n = 0; n < cells / CellsPerNpc; n++)
        {
            var npc = new Npc(mod) { EditorID = $"Npc{rank:D3}x{n}", ShortName = $"Npc {n}", Keywords = [new FormLink<IKeywordGetter>(layer.FormKey)] };
            mod.Npcs.Add(npc);
            if (rank == 0 && n == 0) _recordManyPluginsOverride = npc.FormKey.ToString();
            added++;
        }
        for (var q = 0; q < Math.Max(1, cells / CellsPerQuest); q++) added += AddQuest(mod, rank, q);
        return added;
    }

    // A static's model data stands in for the base records of LitR's other 120 record types, about 0.6 GB of documents.
    private static Model ModelOf(string file, Random data)
    {
        var bytes = new byte[4_000];
        data.NextBytes(bytes);
        return new Model { File = file, Data = bytes };
    }

    private static int FloorDiv(int value, int by) => (int)Math.Floor((double)value / by);

    private static int AddQuest(Fallout4Mod mod, int rank, int q)
    {
        var quest = new Quest(mod) { EditorID = $"Quest{rank:D3}x{q}", Name = $"Quest {q}" };
        var added = 1;
        var text = new Random(rank * 100_003 + q);
        for (var t = 0; t < TopicsPerQuest; t++)
        {
            var topic = new DialogTopic(mod) { EditorID = $"Topic{rank:D3}x{q}x{t}", Quest = new FormLink<IQuestGetter>(quest.FormKey) };
            for (var i = 0; i < (t % 5 == 0 ? 3 : 2); i++)
            {
                var info = new DialogResponses(mod);
                info.Responses.Add(new DialogResponse { Text = Line(text, 220), ScriptNotes = Line(text, 20) });
                topic.Responses.Add(info);
                added++;
            }
            quest.DialogTopics.Add(topic);
            added++;
        }
        mod.Quests.Add(quest);
        return added;
    }

    private static readonly string[] Words =
        ["settler", "raider", "vault", "caps", "power", "armor", "water", "purifier", "signal", "radio", "ruin", "bridge",
         "north", "south", "trader", "doctor", "crate", "ammo", "relay", "tower", "highway", "river", "farm", "brahmin"];

    private static string Line(Random random, int words) =>
        string.Join(' ', Enumerable.Range(0, words).Select(_ => Words[random.Next(Words.Length)]));

    // LitR's navmeshes average 150 KB of document. Every navmesh shares one geometry, since the index holds each one's
    // document whatever it shares.
    private static readonly ExtendedList<P3Float> NavmeshVertices = [.. Enumerable.Range(0, 900).Select(v => new P3Float(v * 1.5f, v * 2.25f, v * 0.125f))];

    private static readonly ExtendedList<NavmeshTriangle> NavmeshTriangles =
        [.. Enumerable.Range(0, 1_700).Select(t => new NavmeshTriangle { Vertices = new P3Int16((short)(t % 900), (short)((t + 1) % 900), (short)((t + 2) % 900)), Height = t * 0.5f })];

    private static NavigationMesh Navmesh(Fallout4Mod mod, ANavmeshParent parent) =>
        new(mod) { NavmeshGeometry = new NavmeshGeometry { Parent = parent, Vertices = NavmeshVertices, Triangles = NavmeshTriangles } };

    private static readonly Array2d<P3UInt8> LandscapeVertices = new(33, 33, new P3UInt8(1, 2, 3));

    private static Landscape Landscape(Fallout4Mod mod) =>
        new(mod) { VertexHeightMap = new LandscapeVertexHeightMap(), VertexNormals = LandscapeVertices, VertexColors = LandscapeVertices };

    public void Dispose() => _folder.Dispose();
}
