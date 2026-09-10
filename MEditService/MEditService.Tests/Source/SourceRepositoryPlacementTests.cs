using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The whole taxonomy: a flat record (a quest included) is a file in its group folder, a
/// container a directory there, an interior Cell one under a block pair.</summary>
public sealed class SourceRepositoryPlacementTests
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Vendor.esp";

    [Fact]
    public void AFlatRecord_IsAFileInItsGroupFolder()
    {
        var placement = SourceRepository.PlacementFor(Plugin, "npc_", "000800:Vendor.esp", "SomeNpc", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Npcs", "SomeNpc - 000800_Vendor.esp.json"),
            placement.RelativePath);
    }

    [Fact]
    public void AQuest_IsAFileInItsGroupFolder()
    {
        var placement = SourceRepository.PlacementFor(Plugin, "Quest", "000800:Vendor.esp", "SomeQuest", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp.json"),
            placement.RelativePath);
    }

    [Fact]
    public void ADirectoryPerRecordContainer_IsADirectoryInItsGroupFolder()
    {
        var placement = SourceRepository.PlacementFor(Plugin, "wrld", "000800:Vendor.esp", "SomeWorld", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Worldspaces", "SomeWorld - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
    }

    [Fact]
    public void AnInteriorCell_NestsUnderABlockPair()
    {
        var placement = SourceRepository.PlacementFor(Plugin, "cell", "000800:Vendor.esp", "SomeCell", Release, blockPath: ["0", "0"]);

        Assert.Equal(
            Path.Combine("source", Plugin, "Cells", "0", "0", "SomeCell - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
    }

    [Fact]
    public void AnExteriorCell_NestsUnderTwoBlockLevelsInsideItsWorldspacesOwnDirectory()
    {
        var subtree = SourceRepository.ExteriorCellSubtreeFor(
            Plugin, "wrld", "000800:Vendor.esp", worldspaceEditorId: null,
            "000801:Vendor.esp", cellEditorId: null,
            new CellPlacement("000800:Vendor.esp", BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, IsInterior: false),
            Release);

        var group = Path.Combine("source", Plugin, "Worldspaces");
        var worldspace = Path.Combine(group, "000800_Vendor.esp");
        var block = Path.Combine(worldspace, "3, -2");
        var subBlock = Path.Combine(block, "0, -1");

        Assert.Equal(group, subtree.GroupDirectory);
        Assert.Equal(worldspace, subtree.WorldspaceDirectory);
        Assert.Equal(Path.Combine(worldspace, "RecordData.json"), subtree.WorldspaceDocument.RelativePath);
        Assert.Equal(Path.Combine(block, "GroupRecordData.json"), subtree.BlockGroupDocument.RelativePath);
        Assert.Equal(Path.Combine(subBlock, "GroupRecordData.json"), subtree.SubBlockGroupDocument.RelativePath);
        Assert.Equal(
            Path.Combine(subBlock, "000801_Vendor.esp", "RecordData.json"), subtree.CellDocument.RelativePath);
    }

    [Fact]
    public void AnExteriorCellsBlockLevels_AreNamedFromThePlacementsOwnNumbers_NotDerived()
    {
        var subtree = SourceRepository.ExteriorCellSubtreeFor(
            Plugin, "wrld", "000800:Vendor.esp", "SomeWorld", "000801:Vendor.esp", "SomeCell",
            new CellPlacement("000800:Vendor.esp", BlockX: -7, BlockY: 11, SubX: 4, SubY: -3, IsInterior: false),
            Release);

        Assert.Equal(
            Path.Combine(
                "source", Plugin, "Worldspaces", "SomeWorld - 000800_Vendor.esp", "-7, 11", "4, -3",
                "SomeCell - 000801_Vendor.esp", "RecordData.json"),
            subtree.CellDocument.RelativePath);
    }

    [Fact]
    public void AnEmbeddedChild_HasNoPlacementOfItsOwn()
    {
        var refused = Assert.Throws<NotSupportedException>(
            () => SourceRepository.PlacementFor(Plugin, "dial", "000801:Vendor.esp", "SomeTopic", Release));

        Assert.Contains("embedded child", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARecordWithNoEditorId_IsNamedByItsFormKeyAlone()
    {
        var placement = SourceRepository.PlacementFor(Plugin, "npc_", "000800:Vendor.esp", editorId: null, Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Npcs", "000800_Vendor.esp.json"), placement.RelativePath);
    }
}
