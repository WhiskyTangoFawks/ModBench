using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreateChildRecordTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ATopicCreatedOnAQuest_LandsLastInItsTopics_AndItsSiblingsKeepTheirOrder()
    {
        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "dial", _fixture.Quest.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            [_fixture.DialogTopic.ToString(), _fixture.DialogTopic2.ToString(), _fixture.DialogTopic3.ToString(), result.NewFormKey.Require()],
            SlotOf(_fixture.Quest, "DialogTopics"));
    }

    public static TheoryData<string, string, string> OneChildOfEachOtherSlot => new()
    {
        { "dlbr", nameof(ContainerModFixture.Quest), "DialogBranches" },
        { "scen", nameof(ContainerModFixture.Quest), "Scenes" },
        { "info", nameof(ContainerModFixture.DialogTopic), "Responses" },
        { "navm", nameof(ContainerModFixture.EmbedCell), "NavigationMeshes" },
    };

    [Theory]
    [MemberData(nameof(OneChildOfEachOtherSlot))]
    public void AChildCreatedOnItsContainer_LandsLastInItsSlot(string recordType, string container, string slot)
    {
        var containerKey = KeyOf(container);
        var siblings = SlotOf(containerKey, slot);

        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, recordType, containerKey.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Equal([.. siblings, result.NewFormKey.Require()], SlotOf(containerKey, slot));
    }

    public static TheoryData<string, string> ChildrenTheContainerCannotHold => new()
    {
        { "npc_", nameof(ContainerModFixture.Quest) },
        { "land", nameof(ContainerModFixture.Cell) },
        { "navm", nameof(ContainerModFixture.TopCell) },
        { "land", nameof(ContainerModFixture.EmbedCell) },
    };

    [Theory]
    [MemberData(nameof(ChildrenTheContainerCannotHold))]
    public void AChildItsContainerCannotHold_IsRefused_AndTheTreeIsAsItWas(string recordType, string container)
    {
        var containerKey = KeyOf(container).ToString();
        var before = TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin);

        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, recordType, containerKey);

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
        Assert.Contains(containerKey, result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin));
    }

    [Fact]
    public void ALandscapeCreatedOnAnExteriorCell_LandsAsItsLandscape()
    {
        using var mod = ExteriorCell(out var cell);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var landscape = JsonNode.Parse(mod.Body(cell)).Require()["Landscape"].Require();
        Assert.Equal(result.NewFormKey, landscape["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void ANavmeshCreatedOnAnExteriorCell_LandsInItsNavmeshes()
    {
        using var mod = ExteriorCell(out var cell);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "navm", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var navmeshes = JsonNode.Parse(mod.Body(cell)).Require()["NavigationMeshes"].Require().AsArray();
        Assert.Equal(result.NewFormKey, Assert.Single(navmeshes).Require()["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void ALandscapeCreatedOnACellHoldingOne_IsRefusedNamingIt_AndTheTreeIsAsItWas()
    {
        using var mod = ExteriorCell(out var cell);
        var held = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString()).NewFormKey.Require();
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString());

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
        Assert.Contains(held, result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void AChildCreatedOnADeletedContainer_IsRefused_AndTheTreeIsAsItWas()
    {
        var questKey = FormKey.Null;
        using var mod = SourceModFixture.Tracked("Deleted.esp", "DeletedMod", plugin =>
        {
            var quest = plugin.Quests.AddNew("DeletedQuest");
            quest.MajorRecordFlagsRaw = DeletedFlag.Bit;
            questKey = quest.FormKey;
        });
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "dial", questKey.ToString());

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void ALandscapeCreatedOnADeletedExteriorCellHoldingOne_IsRefusedAsOneItCannotHold()
    {
        using var mod = ExteriorCell(out var cell, (plugin, cell) =>
        {
            cell.Landscape = new Landscape(plugin);
            cell.MajorRecordFlagsRaw = DeletedFlag.Bit;
        });

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString());

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
    }

    [Fact]
    public void AChildCreatedOnACellTheTreeHoldsOutsideEveryBlock_IsRefusedAsUnreadable_AndTheTreeIsAsItWas()
    {
        var cell = new RecordIdentity(_fixture.Cell.ToString(), "cell", ContainerModPlugin.CellEditorId);
        var directory = TreeTampering.DirectoryOf(_fixture.ModFolder, _fixture.Plugin, cell);
        var group = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(directory))).Require();
        Directory.Move(directory, Path.Combine(group, Path.GetFileName(directory)));
        var before = TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin);

        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "navm", cell.FormKey);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin));
    }

    private static SourceModFixture ExteriorCell(out FormKey cell, Action<Fallout4Mod, Cell>? shape = null)
    {
        var cellKey = FormKey.Null;
        var mod = SourceModFixture.Tracked("Exterior.esp", "ExteriorMod", plugin =>
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

    private string[] SlotOf(FormKey container, string slot) =>
        [.. JsonNode.Parse(_fixture.Document(container.ToString()).Require().Body).Require()[slot].Require().AsArray()
            .Select(child => child.Require()["FormKey"].Require().GetValue<string>())];
}
