using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyContainerPartialFormTests : IDisposable
{
    private const float WaterHeight = 5f;

    private readonly LoadOrderOfPlugins _plugins = new();

    public void Dispose() => _plugins.Dispose();

    private static Cell Cell(Fallout4Mod mod, string editorId, int flags = 0) =>
        new(mod) { EditorID = editorId, WaterHeight = WaterHeight, MajorRecordFlagsRaw = flags };

    private static PlacedObject Placed(Fallout4Mod mod) =>
        new(mod) { EditorID = "CopiedRef", Position = new P3Float(1f, 2f, 3f), Scale = 1f };

    private JsonObject CopyIn(Fallout4Mod source, FormKey child, FormKey container)
    {
        var destination = Plugin("Dest.esp", _ => { });
        _plugins.Load((source, false), (destination, true));
        _plugins.CopyHandler.CopySync(
            [new RecordAt(Address(source), child.ToString())], CopyMode.Override, [Address(destination)], replace: false).OnlyLanded();
        return JsonNode.Parse(_plugins.Text(destination, container)).Require().AsObject();
    }

    [Fact]
    public void AnInteriorCellOfFallout4Esm_CopiedInAroundAChild_IsAPartialFormWithOnlyItsEditorIdAndTheChild()
    {
        FormKey cell = default, placed = default;
        var source = Plugin("Fallout4.esm", mod =>
        {
            var interior = Cell(mod, "InteriorCell", CompressedFlag.Bit);
            var reference = Placed(mod);
            interior.Persistent.Add(reference);
            mod.AddInteriorCells(interior);
            (cell, placed) = (interior.FormKey, reference.FormKey);
        });

        var copied = CopyIn(source, placed, cell);

        Assert.Equal("InteriorCell", copied["EditorID"].Require().GetValue<string>());
        Assert.False(copied.ContainsKey("WaterHeight"));
        var flags = copied["MajorRecordFlagsRaw"].Require().GetValue<int>();
        Assert.NotEqual(0, flags & PartialFormFlag.Bit);
        Assert.Equal(0, flags & CompressedFlag.Bit);
        Assert.Equal(placed.ToString(), Assert.Single(copied["Persistent"].Require().AsArray()).Require()["FormKey"].Require().GetValue<string>());
    }

    private static (Fallout4Mod Source, FormKey Placed, FormKey Document, FormKey Cell) Interior(string plugin, int flags)
    {
        FormKey cell = default, placed = default;
        var source = Plugin(plugin, mod =>
        {
            var interior = Cell(mod, "InteriorCell", flags);
            var reference = Placed(mod);
            interior.Persistent.Add(reference);
            mod.AddInteriorCells(interior);
            (cell, placed) = (interior.FormKey, reference.FormKey);
        });
        return (source, placed, cell, cell);
    }

    private static (Fallout4Mod Source, FormKey Placed, FormKey Document, FormKey Cell) Exterior(int flags, Func<Cell, IList<IPlaced>> slot)
    {
        FormKey cell = default, placed = default;
        var source = Plugin("Fallout4.esm", mod =>
        {
            var worldspace = new Worldspace(mod) { EditorID = "World" };
            var exterior = Cell(mod, "ExteriorCell", flags);
            exterior.Grid = new CellGrid { Point = new P2Int(2, 3) };
            var reference = Placed(mod);
            slot(exterior).Add(reference);
            worldspace.SubCells.Add(CellBlocks.Exterior(exterior));
            mod.Worldspaces.Add(worldspace);
            (cell, placed) = (exterior.FormKey, reference.FormKey);
        });
        return (source, placed, cell, cell);
    }

    private static (Fallout4Mod Source, FormKey Placed, FormKey Document, FormKey Cell) PersistentCellOfAWorldspace()
    {
        FormKey worldspaceKey = default, placed = default, topCell = default;
        var source = Plugin("Fallout4.esm", mod =>
        {
            var worldspace = new Worldspace(mod) { EditorID = "World" };
            var top = Cell(mod, "TopCell");
            var reference = Placed(mod);
            top.Temporary.Add(reference);
            worldspace.TopCell = top;
            mod.Worldspaces.Add(worldspace);
            (worldspaceKey, placed, topCell) = (worldspace.FormKey, reference.FormKey, top.FormKey);
        });
        return (source, placed, worldspaceKey, topCell);
    }

    public static TheoryData<string, Func<(Fallout4Mod, FormKey, FormKey, FormKey)>, Func<JsonObject, JsonObject>, float?, int?> CopiedInCells => new()
    {
        { "a temporary exterior cell of Fallout4.esm, a full override", () => Exterior(0, cell => cell.Temporary), cell => cell, WaterHeight, null },
        { "a persistent exterior cell of Fallout4.esm, a partial form", () => Exterior(PersistentFlag.Bit, cell => cell.Persistent), cell => cell, null, PartialFormFlag.Bit },
        {
            "a worldspace's persistent cell of Fallout4.esm without the persistent flag, a partial form",
            PersistentCellOfAWorldspace, worldspace => worldspace["TopCell"].Require().AsObject(), null, PartialFormFlag.Bit
        },
        { "a partial form cell of Fallout4.esm, still a partial form", () => Interior("Fallout4.esm", PartialFormFlag.Bit), cell => cell, null, PartialFormFlag.Bit },
        { "an interior cell of another plugin, a full override", () => Interior("DLCRobot.esm", 0), cell => cell, WaterHeight, null },
    };

    [Theory]
    [MemberData(nameof(CopiedInCells))]
    public void ACellCopiedInAroundAChild_IsAPartialForm_OnlyWhereXEditWouldMakeOne(
        string _, Func<(Fallout4Mod, FormKey, FormKey, FormKey)> source, Func<JsonObject, JsonObject> cellIn, float? waterHeight, int? partialFormFlag)
    {
        var (mod, placed, document, cellKey) = source();

        var cell = cellIn(CopyIn(mod, placed, document));

        Assert.Equal(
            (cellKey.ToString(), waterHeight, partialFormFlag),
            (cell["FormKey"]?.GetValue<string>(), cell["WaterHeight"]?.GetValue<float>(), cell["MajorRecordFlagsRaw"]?.GetValue<int>() & PartialFormFlag.Bit));
    }
}
