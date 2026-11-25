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

    [Fact]
    public void AChildCreatedOnItsContainer_LandsInAFileOfItsOwnInTheSlotsFolder_AndLeavesTheContainersFileAsItWas()
    {
        var containerKey = _fixture.Quest.ToString();
        var containerFile = SourceModTree.DocumentFile(_fixture.ModFolder, _fixture.Plugin, containerKey).Require();
        var before = File.ReadAllText(Path.Combine(_fixture.ModFolder, containerFile));

        var result = _fixture.CreateHandler.CreateRecordSync(_fixture.Plugin, "dial", containerKey);

        Assert.True(result.Applied, result.Message);
        var created = SourceModTree.DocumentFile(_fixture.ModFolder, _fixture.Plugin, result.NewFormKey.Require()).Require();
        Assert.StartsWith(Path.Combine(Path.GetDirectoryName(containerFile).Require(), "DialogTopics") + Path.DirectorySeparatorChar, created, StringComparison.Ordinal);
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

    [Fact]
    public void AChildItsContainerCannotHold_IsRefused_AndTheTreeIsAsItWas()
    {
        var containerKey = _fixture.Quest.ToString();
        var before = SourceModTree.Records(_fixture.ModFolder, _fixture.Plugin);

        var result = _fixture.CreateHandler.CreateRecordSync(_fixture.Plugin, "npc_", containerKey);

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

    public static TheoryData<string, CellPlace, Action<Cell>, string, string?> CellsAPlacedRecordIsCreatedOn => new()
    {
        { "an exterior cell at a grid", CellPlace.Exterior, cell => cell.Grid = new CellGrid { Point = new P2Int(3, -2) }, PersistentFlag.TemporaryGroup, "14336, -6144, 0" },
        {
            "a persistent interior cell at a grid", CellPlace.Interior,
            cell =>
            {
                cell.MajorRecordFlagsRaw = PersistentFlag.Bit;
                cell.Grid = new CellGrid { Point = new P2Int(3, -2) };
            },
            PersistentFlag.PersistentGroup, null
        },
        { "an interior cell with no grid", CellPlace.Interior, _ => { }, PersistentFlag.TemporaryGroup, null },
    };

    [Theory]
    [MemberData(nameof(CellsAPlacedRecordIsCreatedOn))]
    public void APlacedRecordCreatedOnACell_LandsInTheGroupItsPersistentFlagNames_AtTheCentreOfATemporaryGroupsGrid(
        string _, CellPlace place, Action<Cell> shape, string group, string? position)
    {
        using var mod = CellShaped(place, shape, out var cell);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "refr", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var landed = JsonNode.Parse(mod.Body(cell)).Require();
        var created = Assert.Single(landed[group].Require().AsArray()).Require();
        Assert.Equal(result.NewFormKey, created["FormKey"].Require().GetValue<string>());
        Assert.Equal(group == PersistentFlag.PersistentGroup, (created[RecordHeaderFlags.Member]?.GetValue<int>() ?? 0) == PersistentFlag.Bit);
        Assert.Equal(position, created["Position"]?.GetValue<string>());
    }

    private static SourceModFixture CellShaped(CellPlace place, Action<Cell> shape, out FormKey cell) => place switch
    {
        CellPlace.Interior => InteriorCell(out cell, shape),
        CellPlace.Exterior => ExteriorCell(out cell, (_, exterior) => shape(exterior)),
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
}
