using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class PersistentAcrossCellsTests : IDisposable
{
    private const int Persistent = 0x0400;
    private const float CellWidth = 4096f;

    private static readonly FormKey World = new(Fallout4Esm, 0x900);
    private static readonly FormKey MasterPersistentCell = new(Fallout4Esm, 0x901);
    private static readonly FormKey MasterGridCell = new(Fallout4Esm, 0x902);

    private readonly LoadOrderOfPlugins _plugins = new();
    private readonly Dictionary<string, FormKey> _keys = [];
    private Fallout4Mod? _edited;

    public void Dispose() => _plugins.Dispose();

    private static Fallout4Mod Master(bool withPersistentCell) => Plugin("Fallout4.esm", mod =>
    {
        var world = new Worldspace(World, Fallout4Release.Fallout4) { EditorID = "World" };
        if (withPersistentCell)
        {
            world.TopCell = new Cell(MasterPersistentCell, Fallout4Release.Fallout4)
            {
                EditorID = "MasterPersistentCell",
                MajorRecordFlagsRaw = Persistent,
                WaterHeight = 5f,
            };
            world.TopCell.Persistent.Add(new PlacedObject(mod) { EditorID = "MastersOwn", MajorRecordFlagsRaw = Persistent });
        }
        var grid = new Cell(MasterGridCell, Fallout4Release.Fallout4)
        {
            EditorID = "MasterGrid",
            WaterHeight = 7f,
            Grid = new CellGrid { Point = new P2Int(3, 3) },
        };
        grid.Temporary.Add(new PlacedObject(mod) { EditorID = "MastersTemp" });
        world.SubCells.Add(BlockHolding(grid));
        mod.Worldspaces.Add(world);
    });

    private Fallout4Mod Edited() => Plugin("Override.esp", mod =>
    {
        var world = new Worldspace(World, Fallout4Release.Fallout4) { EditorID = "World" };
        var here = new Cell(mod) { EditorID = "Here", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        here.Temporary.Add(Placed(mod, "Mover", 0, 0.5f));
        here.Persistent.Add(Placed(mod, "Leaver", Persistent, 3.5f));
        here.Persistent.Add(Placed(mod, "Wanderer", Persistent, 9.5f));
        _keys["Here"] = here.FormKey;
        world.SubCells.Add(BlockHolding(here));
        mod.Worldspaces.Add(world);
    });

    private PlacedObject Placed(Fallout4Mod mod, string editorId, int flags, float cells)
    {
        var placed = new PlacedObject(mod)
        {
            EditorID = editorId, MajorRecordFlagsRaw = flags, Position = new P3Float(cells * CellWidth, cells * CellWidth, 0f),
        };
        _keys[editorId] = placed.FormKey;
        return placed;
    }

    private static WorldspaceBlock BlockHolding(Cell cell)
    {
        var (x, y) = (cell.Grid?.Point.X ?? 0, cell.Grid?.Point.Y ?? 0);
        var subBlock = new WorldspaceSubBlock { BlockNumberX = (short)(x / 8), BlockNumberY = (short)(y / 8) };
        subBlock.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = (short)(x / 32), BlockNumberY = (short)(y / 32) };
        block.Items.Add(subBlock);
        return block;
    }

    private void Load(bool masterTracked, bool masterHasPersistentCell = true)
    {
        _edited = Edited();
        _plugins.Load((Master(masterHasPersistentCell), masterTracked), (_edited, true));
    }

    private Fallout4Mod Override => _edited ?? throw new InvalidOperationException("Load the plugins first.");

    private void SetFlags(string placed, int raw)
    {
        var result = _plugins.EditHandler.Edit(
            Address(Override), _keys[placed].ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));
        Assert.True(result.Applied, result.Message);
    }

    private JsonObject Document(FormKey formKey) => JsonNode.Parse(_plugins.Text(Override, formKey)).Require().AsObject();

    private static List<string> Group(JsonObject cell, string group) =>
        [.. (cell[group] as JsonArray ?? []).Select(placed => placed.Require()["EditorID"].Require().GetValue<string>())];

    private SourceRepository Tree => SourceRepository.Open(_plugins.FolderOf(Override), GameRelease.Fallout4).Require();

    [Fact]
    public void SettingPersistent_WhereTheWorldspaceHoldsNoPersistentCell_CopiesItInFromTheCopyToTheLeft()
    {
        Load(masterTracked: false);

        SetFlags("Mover", Persistent);

        var persistentCell = Document(World)["TopCell"].Require().AsObject();
        Assert.Equal(MasterPersistentCell.ToString(), persistentCell["FormKey"].Require().GetValue<string>());
        Assert.Equal("MasterPersistentCell", persistentCell["EditorID"].Require().GetValue<string>());
        Assert.Equal(5f, persistentCell["WaterHeight"].Require().GetValue<float>());
        Assert.Equal(["Mover"], Group(persistentCell, "Persistent"));
        Assert.Empty(Group(Document(_keys["Here"]), "Temporary"));
    }

    [Fact]
    public void SettingPersistent_WithNoPersistentCellToTheLeft_CreatesOne()
    {
        Load(masterTracked: false, masterHasPersistentCell: false);

        SetFlags("Mover", Persistent);

        var persistentCell = Document(World)["TopCell"].Require().AsObject();
        Assert.Equal(Override.ModKey, FormKey.Factory(persistentCell["FormKey"].Require().GetValue<string>()).ModKey);
        Assert.Equal(Persistent, persistentCell["MajorRecordFlagsRaw"].Require().GetValue<int>() & Persistent);
        Assert.Equal(["Mover"], Group(persistentCell, "Persistent"));
    }

    [Fact]
    public void ClearingPersistent_WhereThePluginLacksTheCellAtItsPosition_CopiesItInFromTheCopyToTheLeft()
    {
        Load(masterTracked: true);

        SetFlags("Leaver", 0);

        var copied = Document(MasterGridCell);
        Assert.Equal("MasterGrid", copied["EditorID"].Require().GetValue<string>());
        Assert.Equal(7f, copied["WaterHeight"].Require().GetValue<float>());
        Assert.Equal(["Leaver"], Group(copied, "Temporary"));
        Assert.Equal(["Wanderer"], Group(Document(_keys["Here"]), "Persistent"));
    }

    [Fact]
    public void ClearingPersistent_WithNoCellAtItsPositionToTheLeft_CreatesOneAtItsGrid()
    {
        Load(masterTracked: true);

        SetFlags("Wanderer", 0);

        var created = Tree.CellAt(Address(Override), World.ToString(), 9, 9).Require();
        Assert.Equal(Override.ModKey, FormKey.Factory(created).ModKey);
        Assert.Equal(["Wanderer"], Group(Document(FormKey.Factory(created)), "Temporary"));
        var identity = Tree.IdentityOf(Address(Override), created, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)) ?? throw new InvalidOperationException("Expected the created cell to be held.");
        Assert.Equal(new CellPlacement(World.ToString(), 0, 0, 1, 1, IsInterior: false), Tree.CellPlacementOf(Address(Override), identity));
    }
}
