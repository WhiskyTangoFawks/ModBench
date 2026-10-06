using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
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
    private static readonly FormKey MiddleStatic = new(ModKey.FromFileName("Middle.esp"), 0x900);

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
        world.SubCells.Add(CellBlocks.Exterior(grid));
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
        var bystander = new Static(mod) { EditorID = "Bystander" };
        _keys["Bystander"] = bystander.FormKey;
        mod.Statics.Add(bystander);
        world.SubCells.Add(CellBlocks.Exterior(here));
        mod.Worldspaces.Add(world);
    });

    private PlacedObject Placed(Fallout4Mod mod, string editorId, int flags, float cells)
    {
        var placed = new PlacedObject(mod)
        {
            EditorID = editorId,
            MajorRecordFlagsRaw = flags,
            Position = new P3Float(cells * CellWidth, cells * CellWidth, 0f),
        };
        _keys[editorId] = placed.FormKey;
        return placed;
    }

    private static Fallout4Mod Middle(Action<Fallout4Mod, Worldspace> holds) => Plugin("Middle.esp", mod =>
    {
        mod.Statics.Add(new Static(MiddleStatic, Fallout4Release.Fallout4) { EditorID = "MiddleStatic" });
        var world = new Worldspace(World, Fallout4Release.Fallout4) { EditorID = "World" };
        holds(mod, world);
        mod.Worldspaces.Add(world);
    });

    private void Load(bool masterTracked, bool masterHasPersistentCell = true, Fallout4Mod? middle = null)
    {
        _edited = Edited();
        _plugins.Load([(Master(masterHasPersistentCell), masterTracked), .. middle is null ? [] : new[] { (middle, false) }, (_edited, true)]);
    }

    private Fallout4Mod Override => _edited ?? throw new InvalidOperationException("Load the plugins first.");

    private void SetFlags(string placed, int raw)
    {
        var result = _plugins.EditHandler.Edit(
            Address(Override), _keys[placed].ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));
        Assert.True(result.Applied, result.Message);
    }

    private void SetBase(string placed, FormKey baseRecord)
    {
        var result = _plugins.EditHandler.Edit(
            Address(Override), _keys[placed].ToString(),
            SetAt(JsonSerializer.SerializeToElement(baseRecord.ToString()), Member("Base")));
        Assert.True(result.Applied, result.Message);
    }

    private JsonObject Document(FormKey formKey) => JsonNode.Parse(_plugins.Text(Override, formKey)).Require().AsObject();

    private static List<string> Group(JsonObject cell, string group) =>
        [.. (cell[group] as JsonArray ?? []).Select(placed => placed.Require()["EditorID"].Require().GetValue<string>())];

    private SourceRepository Tree => SourceRepository.Open(TestMod.In(_plugins.FolderOf(Override)), GameRelease.Fallout4).Require();

    [Fact]
    public void SettingPersistent_WhereTheWorldspaceHoldsNoPersistentCell_CopiesItInFromItsMaster()
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
    public void SettingPersistent_WithNoPersistentCellInAMaster_CreatesOne()
    {
        Load(masterTracked: false, masterHasPersistentCell: false);

        SetFlags("Mover", Persistent);

        var persistentCell = Document(World)["TopCell"].Require().AsObject();
        Assert.Equal(Override.ModKey, FormKey.Factory(persistentCell["FormKey"].Require().GetValue<string>()).ModKey);
        Assert.Equal(Persistent, persistentCell["MajorRecordFlagsRaw"].Require().GetValue<int>() & Persistent);
        Assert.Equal(["Mover"], Group(persistentCell, "Persistent"));
        Assert.Empty(Group(Document(_keys["Here"]), "Temporary"));
    }

    [Fact]
    public void ClearingPersistent_WhereThePluginLacksTheCellAtItsPosition_CopiesItInFromItsMaster()
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
    public void ClearingPersistent_WhereThePluginLacksTheCellAtItsPosition_CopiesItInFromAnUntrackedMaster()
    {
        Load(masterTracked: false);

        SetFlags("Leaver", 0);

        var copied = Document(MasterGridCell);
        Assert.Equal("MasterGrid", copied["EditorID"].Require().GetValue<string>());
        Assert.Equal(["Leaver"], Group(copied, "Temporary"));
    }

    [Fact]
    public void ClearingPersistent_WithNoCellAtItsPositionInAMaster_CreatesOneAtItsGrid()
    {
        Load(masterTracked: true);

        SetFlags("Wanderer", 0);

        var created = Tree.GetCellAt(Address(Override), World.ToString(), 9, 9, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)).Require();
        Assert.Equal(Override.ModKey, FormKey.Factory(created.FormKey).ModKey);
        Assert.Equal(["Wanderer"], Group(Document(FormKey.Factory(created.FormKey)), "Temporary"));
        Assert.Equal(["Leaver"], Group(Document(_keys["Here"]), "Persistent"));
    }

    [Fact]
    public void SettingPersistent_WhereOnlyAPluginThatIsNoMasterOverridesThePersistentCell_CopiesItInFromTheMaster()
    {
        Load(masterTracked: false, middle: Middle((_, world) => world.TopCell = new Cell(MasterPersistentCell, Fallout4Release.Fallout4)
        {
            EditorID = "MiddlesPersistentCell",
            MajorRecordFlagsRaw = Persistent,
            WaterHeight = 9f,
        }));

        SetFlags("Mover", Persistent);

        var persistentCell = Document(World)["TopCell"].Require().AsObject();
        Assert.Equal("MasterPersistentCell", persistentCell["EditorID"].Require().GetValue<string>());
        Assert.Equal(5f, persistentCell["WaterHeight"].Require().GetValue<float>());
    }

    [Fact]
    public void SettingPersistent_WhereOnlyAPluginThatIsNoMasterHoldsAPersistentCell_CreatesOne()
    {
        Load(masterTracked: false, masterHasPersistentCell: false, middle: Middle((mod, world) =>
            world.TopCell = new Cell(mod) { EditorID = "MiddlesPersistentCell", MajorRecordFlagsRaw = Persistent }));

        SetFlags("Mover", Persistent);

        var persistentCell = Document(World)["TopCell"].Require().AsObject();
        Assert.Equal(Override.ModKey, FormKey.Factory(persistentCell["FormKey"].Require().GetValue<string>()).ModKey);
        Assert.Equal(["Mover"], Group(persistentCell, "Persistent"));
    }

    [Fact]
    public void SettingPersistent_WhereTheWorkingTreeHasMadeAPluginAMaster_CopiesThePersistentCellInFromIt()
    {
        Load(masterTracked: false, middle: Middle((_, world) => world.TopCell = new Cell(MasterPersistentCell, Fallout4Release.Fallout4)
        {
            EditorID = "MiddlesPersistentCell",
            MajorRecordFlagsRaw = Persistent,
            WaterHeight = 9f,
        }));
        SetBase("Mover", MiddleStatic);

        SetFlags("Mover", Persistent);

        var persistentCell = Document(World)["TopCell"].Require().AsObject();
        Assert.Equal("MiddlesPersistentCell", persistentCell["EditorID"].Require().GetValue<string>());
    }

    [Fact]
    public void ClearingPersistent_WhereOnlyAPluginThatIsNoMasterHoldsTheCellAtItsPosition_CreatesOne()
    {
        Load(masterTracked: false, middle: Middle((mod, world) =>
            world.SubCells.Add(CellBlocks.Exterior(new Cell(mod) { EditorID = "MiddlesCell", Grid = new CellGrid { Point = new P2Int(9, 9) } }))));

        SetFlags("Wanderer", 0);

        var created = Tree.GetCellAt(Address(Override), World.ToString(), 9, 9, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)).Require();
        Assert.Equal(Override.ModKey, FormKey.Factory(created.FormKey).ModKey);
        Assert.Equal(["Wanderer"], Group(Document(FormKey.Factory(created.FormKey)), "Temporary"));
    }

    [Fact]
    public void ClearingPersistent_WhereAMasterHoldsTheCellAndAPluginThatIsNoMasterOverridesIt_CopiesTheMastersCell()
    {
        Load(masterTracked: false, middle: Middle((_, world) => world.SubCells.Add(CellBlocks.Exterior(
            new Cell(MasterGridCell, Fallout4Release.Fallout4)
            {
                EditorID = "MiddlesGrid",
                WaterHeight = 9f,
                Grid = new CellGrid { Point = new P2Int(3, 3) },
            }))));

        SetFlags("Leaver", 0);

        var copied = Document(MasterGridCell);
        Assert.Equal("MasterGrid", copied["EditorID"].Require().GetValue<string>());
        Assert.Equal(7f, copied["WaterHeight"].Require().GetValue<float>());
    }

    [Fact]
    public void SettingPersistent_WhenADocumentInThePluginsTreeIsNoJson_IsRefusedNamingIt_AndWritesNothing()
    {
        Load(masterTracked: true);
        _plugins.Respell(Override, _keys["Bystander"], "stat", "{", "[");
        var before = _plugins.Text(Override, _keys["Here"]);

        var result = _plugins.EditHandler.Edit(
            Address(Override), _keys["Mover"].ToString(),
            SetAt(JsonDocument.Parse(Persistent.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("Statics", result.Message, StringComparison.Ordinal);
        Assert.Contains("moves into comes only from a master of", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _plugins.Text(Override, _keys["Here"]));
    }
}
