using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceRepo;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.TestSupport;

/// <summary>A tracked mod whose records nest: cells holding placed references, a navigation mesh
/// and a landscape, and a worldspace holding a top cell that holds its own reference. The flat
/// fixtures cannot exercise a container at all.</summary>
internal sealed class ContainerMod : IDisposable
{
    public const string PluginName = "ContainerFixture.esp";
    public const string Origin = "ContainerFixtureMod";

    public const string CellEditorId = "FixtureCell";
    public const string EmbedCellEditorId = "EmbedCell";
    public const string TemporaryRefEditorId = "TempRef";
    public const string PersistentRefEditorId = "PersistRef";
    public const string NavmeshEditorId = "EmbedNavmesh";
    public const string LandscapeEditorId = "EmbedLandscape";
    public const string WorldspaceEditorId = "EmbedWorld";
    public const string TopCellEditorId = "EmbedTopCell";
    public const string TopCellRefEditorId = "TopCellRef";

    private readonly ScatteredFixtureData _fixture;

    public LoadOrderEntry Entry { get; }
    public PluginCopyKey Plugin => Entry.KeyOf();
    public string GameDirectory => _fixture.GameDirectory;

    public FormKey Cell { get; }
    public FormKey EmbedCell { get; }
    public FormKey TemporaryRef { get; }
    public FormKey PersistentRef { get; }
    public FormKey Navmesh { get; }
    public FormKey Landscape { get; }
    public FormKey Worldspace { get; }
    public FormKey TopCell { get; }
    public FormKey TopCellRef { get; }

    public ContainerMod()
    {
        FormKey cell = default, embedCell = default, temporaryRef = default, persistentRef = default;
        FormKey navmesh = default, landscape = default, worldspace = default, topCell = default, topCellRef = default;

        _fixture = new PluginFixtureBuilder("container-mod")
            .WithPlugin(PluginName, mod =>
            {
                var interior = new Cell(mod) { EditorID = CellEditorId, WaterHeight = 100f };
                AddInteriorCell(mod, interior, blockNumber: 0);
                cell = interior.FormKey;

                var embed = new Cell(mod) { EditorID = EmbedCellEditorId, WaterHeight = 10f };
                var temporary = new PlacedObject(mod)
                {
                    EditorID = TemporaryRefEditorId,
                    Position = new P3Float(11f, 22f, 33f),
                    Scale = 1f,
                };
                var persistent = new PlacedObject(mod)
                {
                    EditorID = PersistentRefEditorId,
                    Position = new P3Float(1f, 2f, 3f),
                    Scale = 4f,
                };
                var mesh = new NavigationMesh(mod) { EditorID = NavmeshEditorId };
                var land = new Landscape(mod) { EditorID = LandscapeEditorId };
                embed.Temporary.Add(temporary);
                embed.Persistent.Add(persistent);
                embed.NavigationMeshes.Add(mesh);
                embed.Landscape = land;
                AddInteriorCell(mod, embed, blockNumber: 1);
                (embedCell, temporaryRef, persistentRef) = (embed.FormKey, temporary.FormKey, persistent.FormKey);
                (navmesh, landscape) = (mesh.FormKey, land.FormKey);

                var world = new Worldspace(mod) { EditorID = WorldspaceEditorId };
                var top = new Cell(mod) { EditorID = TopCellEditorId, WaterHeight = 5f };
                var topRef = new PlacedObject(mod)
                {
                    EditorID = TopCellRefEditorId,
                    Position = new P3Float(7f, 8f, 9f),
                    Scale = 6f,
                };
                top.Temporary.Add(topRef);
                world.TopCell = top;
                mod.Worldspaces.Add(world);
                (worldspace, topCell, topCellRef) = (world.FormKey, top.FormKey, topRef.FormKey);
            }, origin: Origin)
            .BuildScattered()
            .Tracked();

        Entry = _fixture.Plugins.Single();
        Cell = cell;
        (EmbedCell, TemporaryRef, PersistentRef) = (embedCell, temporaryRef, persistentRef);
        (Navmesh, Landscape) = (navmesh, landscape);
        (Worldspace, TopCell, TopCellRef) = (worldspace, topCell, topCellRef);
    }

    /// <summary>Any document of the tree: a container's own file, or the file that inlines an
    /// embedded child.</summary>
    public string SourceFileContaining(string editorId) =>
        Directory.EnumerateFiles(
                Path.Combine(Entry.ModFolderOf(), SourceRepository.RootFor(PluginName)), "*.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    public void Dispose() => _fixture.Dispose();

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell, int blockNumber)
    {
        var subBlock = new CellSubBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }
}

/// <summary>The container mod with an index over it, reconciled the way the composition root
/// reconciles: the Index reads the tracked tree.</summary>
internal sealed class IndexedContainerMod : IDisposable
{
    private readonly ContainerMod _mod = new();

    public IndexProjector Index { get; }

    public IndexedContainerMod(INotificationPublisher? notifications = null) =>
        Index = Indexes.Reconciled(_mod.GameDirectory, [_mod.Entry], notifications: notifications);

    public ContainerMod Mod => _mod;
    public LoadOrderEntry Entry => _mod.Entry;
    public PluginCopyKey Plugin => _mod.Plugin;
    public IRecordReads Reads => Index.RequireReads();

    // The reads take a FormKey as text, so the fixture answers in the form its callers ask in.
    public string Cell => _mod.Cell.ToString();
    public string EmbedCell => _mod.EmbedCell.ToString();
    public string TemporaryRef => _mod.TemporaryRef.ToString();
    public string PersistentRef => _mod.PersistentRef.ToString();
    public string Worldspace => _mod.Worldspace.ToString();
    public string TopCell => _mod.TopCell.ToString();
    public string TopCellRef => _mod.TopCellRef.ToString();

    public void Dispose()
    {
        Index.Dispose();
        _mod.Dispose();
    }
}
