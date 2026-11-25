using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreateChildRecordTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    public static TheoryData<string, string, string> OneChildOfEachSlotFiledInItsContainersDirectory => new()
    {
        { "dial", nameof(ContainerModFixture.Quest), "DialogTopics" },
    };

    [Theory]
    [MemberData(nameof(OneChildOfEachSlotFiledInItsContainersDirectory))]
    public void AChildCreatedOnItsContainer_LandsInAFileOfItsOwnInTheSlotsFolder_AndLeavesTheContainersFileAsItWas(
        string recordType, string container, string slot)
    {
        var containerKey = KeyOf(container).ToString();
        var containerFile = SourceModTree.DocumentFile(_fixture.ModFolder, _fixture.Plugin, containerKey).Require();
        var before = File.ReadAllText(Path.Combine(_fixture.ModFolder, containerFile));

        var result = _fixture.CreateHandler.CreateRecordSync(_fixture.Plugin, recordType, containerKey);

        Assert.True(result.Applied, result.Message);
        var created = SourceModTree.DocumentFile(_fixture.ModFolder, _fixture.Plugin, result.NewFormKey.Require()).Require();
        Assert.StartsWith(Path.Combine(Path.GetDirectoryName(containerFile).Require(), slot) + Path.DirectorySeparatorChar, created, StringComparison.Ordinal);
        Assert.Equal(before, File.ReadAllText(Path.Combine(_fixture.ModFolder, containerFile)));
    }

    [Fact]
    public void AChildCreatedOnAnUnsavedContainer_LandsInTheTextItHolds_AndWritesNothing()
    {
        var file = Path.Combine(_fixture.ModFolder, SourceModTree.DocumentFile(_fixture.ModFolder, _fixture.Plugin, _fixture.EmbedCell.ToString()).Require());
        var onDisk = JsonNode.Parse(File.ReadAllText(file)).Require().AsObject();
        onDisk["Temporary"].Require().AsArray().RemoveAt(0);
        var held = onDisk.ToJsonString();
        var before = File.ReadAllText(file);

        _fixture.Unsaved.Typed(new DocumentChange(file, held));

        var (outcome, changes) = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "navm", _fixture.EmbedCell.ToString());

        Assert.True(outcome.Applied, outcome.Message);
        Assert.Equal(before, File.ReadAllText(file));
        var cell = JsonNode.Parse(Assert.Single(changes.Require().Documents, document => document.Path == file).Text).Require();
        Assert.Empty(cell["Temporary"].Require().AsArray());
        Assert.Equal(outcome.NewFormKey, cell["NavigationMeshes"].Require().AsArray()[^1].Require()["FormKey"].Require().GetValue<string>());
    }

    public static TheoryData<string, string> ChildrenTheContainerCannotHold => new()
    {
        { "npc_", nameof(ContainerModFixture.Quest) },
    };

    [Theory]
    [MemberData(nameof(ChildrenTheContainerCannotHold))]
    public void AChildItsContainerCannotHold_IsRefused_AndTheTreeIsAsItWas(string recordType, string container)
    {
        var containerKey = KeyOf(container).ToString();
        var before = SourceModTree.Records(_fixture.ModFolder, _fixture.Plugin);

        var result = _fixture.CreateHandler.CreateRecordSync(_fixture.Plugin, recordType, containerKey);

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
        Assert.Contains(containerKey, result.Message, StringComparison.Ordinal);
        Assert.Equal(before, SourceModTree.Records(_fixture.ModFolder, _fixture.Plugin));
    }

    [Fact]
    public void ALandscapeCreatedOnACellHoldingOne_IsRefusedNamingIt_AndTheTreeIsAsItWas()
    {
        using var mod = ExteriorCell(out var cell);
        var held = mod.CreateHandler.CreateRecordSync(mod.Plugin, "land", cell.ToString()).NewFormKey.Require();
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "land", cell.ToString());

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
        Assert.Contains(held, result.Message, StringComparison.Ordinal);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void AChildCreatedOnACellTheTreeHoldsOutsideEveryBlock_IsRefusedAsUnreadable_AndTheTreeIsAsItWas()
    {
        var cell = new RecordIdentity(_fixture.Cell.ToString(), "cell", ContainerModPlugin.CellEditorId);
        var directory = TreeTampering.DirectoryOf(_fixture.ModFolder, _fixture.Plugin, cell);
        var group = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(directory))).Require();
        Directory.Move(directory, Path.Combine(group, Path.GetFileName(directory)));
        var before = SourceModTree.Records(_fixture.ModFolder, _fixture.Plugin);

        var result = _fixture.CreateHandler.CreateRecordSync(_fixture.Plugin, "navm", cell.FormKey);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(before, SourceModTree.Records(_fixture.ModFolder, _fixture.Plugin));
    }

    public static TheoryData<bool, CellPlace> EachCellShape => new()
    {
        { true, CellPlace.Interior },
    };

    [Theory]
    [MemberData(nameof(EachCellShape))]
    public void APlacedRecordCreatedOnACell_LandsInTheGroupItsPersistentFlagNames_PersistentAsItsGroup(bool persistent, CellPlace place)
    {
        using var mod = CellShaped(place, cell => cell.MajorRecordFlagsRaw = persistent ? PersistentFlag.Bit : 0, out var cell);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "refr", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var landed = JsonNode.Parse(mod.Body(cell)).Require();
        var group = persistent ? PersistentFlag.PersistentGroup : PersistentFlag.TemporaryGroup;
        var created = Assert.Single(landed[group].Require().AsArray()).Require();
        Assert.Equal(result.NewFormKey, created["FormKey"].Require().GetValue<string>());
        Assert.Null(landed[persistent ? PersistentFlag.TemporaryGroup : PersistentFlag.PersistentGroup]);
        Assert.Equal(persistent, (created[RecordHeaderFlags.Member]?.GetValue<int>() ?? 0) == PersistentFlag.Bit);
    }

    [Theory]
    [InlineData("refr", CellPlace.Exterior)]
    public void APlacedRecordCreatedOnACellWithAGrid_LandsInItsTemporaryGroup_AtTheCentreOfTheGridCell(string recordType, CellPlace place)
    {
        using var mod = CellShaped(place, cell => cell.Grid = new CellGrid { Point = new P2Int(3, -2) }, out var cell);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, recordType, cell.ToString());

        Assert.True(result.Applied, result.Message);
        var created = Assert.Single(JsonNode.Parse(mod.Body(cell)).Require()[PersistentFlag.TemporaryGroup].Require().AsArray()).Require();
        Assert.Equal(result.NewFormKey, created["FormKey"].Require().GetValue<string>());
        Assert.Equal("14336, -6144, 0", created["Position"].Require().GetValue<string>());
    }

    [Theory]
    [InlineData(CellPlace.Interior)]
    public void APlacedRecordCreatedOnAPersistentCellWithAGrid_KeepsTheBarePosition_WhereverTheCellSits(CellPlace place)
    {
        using var mod = CellShaped(
            place,
            cell =>
            {
                cell.MajorRecordFlagsRaw = PersistentFlag.Bit;
                cell.Grid = new CellGrid { Point = new P2Int(3, -2) };
            },
            out var cell);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "refr", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var created = Assert.Single(JsonNode.Parse(mod.Body(cell)).Require()[PersistentFlag.PersistentGroup].Require().AsArray()).Require();
        Assert.Null(created["Position"]);
    }

    [Fact]
    public void APlacedRecordCreatedOnACellWithNoGrid_KeepsTheBarePosition()
    {
        using var mod = InteriorCell(out var cell, _ => { });

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "refr", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var created = Assert.Single(JsonNode.Parse(mod.Body(cell)).Require()[PersistentFlag.TemporaryGroup].Require().AsArray()).Require();
        Assert.Null(created["Position"]);
    }

    private static SourceModFixture CellShaped(CellPlace place, Action<Cell> shape, out FormKey cell) => place switch
    {
        CellPlace.Interior => InteriorCell(out cell, shape),
        CellPlace.Exterior => ExteriorCell(out cell, (_, exterior) => shape(exterior)),
        CellPlace.PersistentWorldspaceCell => WorldspacePersistentCell(out cell, shape),
        _ => throw new ArgumentOutOfRangeException(nameof(place), place, "No fixture builds a cell there."),
    };

    private static SourceModFixture InteriorCell(out FormKey cell, Action<Cell> shape)
    {
        var cellKey = FormKey.Null;
        var mod = SourceModFixture.CompiledPlugin("Interior.esp", "InteriorMod", plugin =>
        {
            var interior = new Cell(plugin) { EditorID = "InteriorCell", Flags = Cell.Flag.IsInteriorCell };
            shape(interior);
            plugin.AddInteriorCells(interior);
            cellKey = interior.FormKey;
        });
        cell = cellKey;
        return mod;
    }

    private static SourceModFixture WorldspacePersistentCell(out FormKey cell, Action<Cell> shape)
    {
        var cellKey = FormKey.Null;
        var mod = SourceModFixture.CompiledPlugin("Persistent.esp", "PersistentMod", plugin =>
        {
            var persistentCell = new Cell(plugin) { EditorID = "PersistentCell" };
            shape(persistentCell);
            plugin.Worldspaces.AddNew("World").TopCell = persistentCell;
            cellKey = persistentCell.FormKey;
        });
        cell = cellKey;
        return mod;
    }

    private static SourceModFixture ExteriorCell(out FormKey cell, Action<Fallout4Mod, Cell>? shape = null)
    {
        var cellKey = FormKey.Null;
        var mod = SourceModFixture.CompiledPlugin("Exterior.esp", "ExteriorMod", plugin =>
        {
            var exterior = new Cell(plugin) { EditorID = "ExteriorCell", Grid = new CellGrid() };
            shape?.Invoke(plugin, exterior);
            plugin.Worldspaces.AddNew("World").SubCells.Add(CellBlocks.Exterior(exterior));
            cellKey = exterior.FormKey;
        });
        cell = cellKey;
        return mod;
    }

    private FormKey KeyOf(string container) =>
        (FormKey)typeof(ContainerModFixture).GetProperty(container).Require().GetValue(_fixture).Require();
}
