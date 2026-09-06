using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The whole taxonomy: a flat record (a quest included) is a file in its group folder, a
/// container a directory there, an interior Cell one under a block pair.</summary>
public sealed class SourcePlacementTests
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Vendor.esp";

    [Fact]
    public void AFlatRecord_IsAFileInItsGroupFolder()
    {
        var placement = SourcePlacement.For(Plugin, "npc_", "000800:Vendor.esp", "SomeNpc", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Npcs", "SomeNpc - 000800_Vendor.esp.json"),
            placement.RelativePath);
    }

    [Fact]
    public void AQuest_IsAFileInItsGroupFolder()
    {
        var placement = SourcePlacement.For(Plugin, "Quest", "000800:Vendor.esp", "SomeQuest", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp.json"),
            placement.RelativePath);
    }

    [Fact]
    public void ADirectoryPerRecordContainer_IsADirectoryInItsGroupFolder()
    {
        var placement = SourcePlacement.For(Plugin, "wrld", "000800:Vendor.esp", "SomeWorld", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Worldspaces", "SomeWorld - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
    }

    [Fact]
    public void AnInteriorCell_NestsUnderABlockPair()
    {
        var placement = SourcePlacement.For(Plugin, "cell", "000800:Vendor.esp", "SomeCell", Release, blockPath: ["0", "0"]);

        Assert.Equal(
            Path.Combine("source", Plugin, "Cells", "0", "0", "SomeCell - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
    }

    [Fact]
    public void AnEmbeddedChild_HasNoPlacementOfItsOwn()
    {
        var refused = Assert.Throws<NotSupportedException>(
            () => SourcePlacement.For(Plugin, "dial", "000801:Vendor.esp", "SomeTopic", Release));

        Assert.Contains("embedded child", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARecordWithNoEditorId_IsNamedByItsFormKeyAlone()
    {
        var placement = SourcePlacement.For(Plugin, "npc_", "000800:Vendor.esp", editorId: null, Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Npcs", "000800_Vendor.esp.json"), placement.RelativePath);
    }
}
