using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The one cell whose directory sits inside another record's: the spatial mint asks for the
/// whole subtree at once, so these are paths rather than a tree a put left behind.</summary>
public sealed class ExteriorCellSubtreePlacementTests
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Vendor.esp";

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
}
