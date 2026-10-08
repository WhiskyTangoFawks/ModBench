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
    private const int Compressed = 0x40000;

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
            var interior = Cell(mod, "InteriorCell", Compressed);
            var reference = Placed(mod);
            interior.Persistent.Add(reference);
            mod.Cells.Records.Add(CellBlocks.Interior(interior));
            (cell, placed) = (interior.FormKey, reference.FormKey);
        });

        var copied = CopyIn(source, placed, cell);

        Assert.Equal("InteriorCell", copied["EditorID"].Require().GetValue<string>());
        Assert.False(copied.ContainsKey("WaterHeight"));
        var flags = copied["MajorRecordFlagsRaw"].Require().GetValue<int>();
        Assert.NotEqual(0, flags & PartialFormFlag.Bit);
        Assert.Equal(0, flags & Compressed);
        Assert.Equal(placed.ToString(), Assert.Single(copied["Persistent"].Require().AsArray()).Require()["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void ATemporaryExteriorCellOfFallout4Esm_CopiedInAroundAChild_IsAFullOverride()
    {
        FormKey cell = default, placed = default;
        var source = Plugin("Fallout4.esm", mod =>
        {
            var worldspace = new Worldspace(mod) { EditorID = "World" };
            var exterior = Cell(mod, "ExteriorCell");
            exterior.Grid = new CellGrid { Point = new P2Int(2, 3) };
            var reference = Placed(mod);
            exterior.Temporary.Add(reference);
            worldspace.SubCells.Add(CellBlocks.Exterior(exterior));
            mod.Worldspaces.Add(worldspace);
            (cell, placed) = (exterior.FormKey, reference.FormKey);
        });

        var copied = CopyIn(source, placed, cell);

        Assert.Equal(WaterHeight, copied["WaterHeight"].Require().GetValue<float>());
        Assert.False(copied.ContainsKey("MajorRecordFlagsRaw"));
    }

    [Fact]
    public void APersistentExteriorCellOfFallout4Esm_CopiedInAroundAChild_IsAPartialForm()
    {
        FormKey cell = default, placed = default;
        var source = Plugin("Fallout4.esm", mod =>
        {
            var worldspace = new Worldspace(mod) { EditorID = "World" };
            var exterior = Cell(mod, "ExteriorCell", PersistentFlag.Bit);
            exterior.Grid = new CellGrid { Point = new P2Int(2, 3) };
            var reference = Placed(mod);
            exterior.Persistent.Add(reference);
            worldspace.SubCells.Add(CellBlocks.Exterior(exterior));
            mod.Worldspaces.Add(worldspace);
            (cell, placed) = (exterior.FormKey, reference.FormKey);
        });

        var copied = CopyIn(source, placed, cell);

        Assert.False(copied.ContainsKey("WaterHeight"));
        Assert.NotEqual(0, copied["MajorRecordFlagsRaw"].Require().GetValue<int>() & PartialFormFlag.Bit);
    }

    [Fact]
    public void APartialFormCellOfFallout4Esm_CopiedInAroundAChild_StaysAPartialForm()
    {
        FormKey cell = default, placed = default;
        var source = Plugin("Fallout4.esm", mod =>
        {
            var interior = new Cell(mod) { EditorID = "InteriorCell", MajorRecordFlagsRaw = PartialFormFlag.Bit };
            var reference = Placed(mod);
            interior.Persistent.Add(reference);
            mod.Cells.Records.Add(CellBlocks.Interior(interior));
            (cell, placed) = (interior.FormKey, reference.FormKey);
        });

        var copied = CopyIn(source, placed, cell);

        Assert.NotEqual(0, copied["MajorRecordFlagsRaw"].Require().GetValue<int>() & PartialFormFlag.Bit);
    }

    [Fact]
    public void AnInteriorCellOfAnotherPlugin_CopiedInAroundAChild_IsAFullOverride()
    {
        FormKey cell = default, placed = default;
        var source = Plugin("DLCRobot.esm", mod =>
        {
            var interior = Cell(mod, "DlcCell");
            var reference = Placed(mod);
            interior.Persistent.Add(reference);
            mod.Cells.Records.Add(CellBlocks.Interior(interior));
            (cell, placed) = (interior.FormKey, reference.FormKey);
        });

        var copied = CopyIn(source, placed, cell);

        Assert.Equal(WaterHeight, copied["WaterHeight"].Require().GetValue<float>());
        Assert.False(copied.ContainsKey("MajorRecordFlagsRaw"));
    }
}
