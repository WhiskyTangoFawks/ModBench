using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The three shapes are the whole taxonomy: a flat record is a file in its group
/// folder, a top-level container a directory there, an interior Cell one under a block
/// pair.</summary>
public sealed class SourcePlacementTests
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Vendor.esp";

    [Fact]
    public void AFlatRecord_IsAFileInItsGroupFolder_ListedUnderTheGroupsOwnName()
    {
        var placement = SourcePlacement.For(Plugin, "npc_", "000800:Vendor.esp", "SomeNpc", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Npcs", "SomeNpc - 000800_Vendor.esp.json"),
            placement.RelativePath);
        Assert.Equal(Path.Combine("source", Plugin, "Npcs", "GroupRecordData.json"), placement.CarrierRelativePath);
        Assert.Equal("Npcs", placement.Key);
    }

    [Fact]
    public void ATopLevelContainer_IsADirectoryInItsGroupFolder_ListedUnderTheGroupsOwnName()
    {
        var placement = SourcePlacement.For(Plugin, "Quest", "000800:Vendor.esp", "SomeQuest", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
        Assert.Equal(Path.Combine("source", Plugin, "Quests", "GroupRecordData.json"), placement.CarrierRelativePath);
        Assert.Equal("Quests", placement.Key);
    }

    [Fact]
    public void AnInteriorCell_NestsUnderABlockPair_ListedUnderTheSubBlocksOwnMember()
    {
        var placement = SourcePlacement.For(Plugin, "Cell", "000800:Vendor.esp", "SomeCell", Release, blockPath: ["0", "0"]);

        Assert.Equal(
            Path.Combine("source", Plugin, "Cells", "0", "0", "SomeCell - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
        Assert.Equal(
            Path.Combine("source", Plugin, "Cells", "0", "0", "GroupRecordData.json"),
            placement.CarrierRelativePath);
        Assert.Equal("Cells", placement.Key);
    }

    [Fact]
    public void AFolderSplitContainerChild_IsADirectoryInItsParentsSlot_ListedInTheParentsOwnDocument()
    {
        var modFolder = Path.Combine(Path.GetTempPath(), "some-mod");
        var questDirectory = Path.Combine(modFolder, "source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp");

        var placement = SourcePlacement.ForSlotChild(
            modFolder, questDirectory, "DialogTopics", "000801:Vendor.esp", "SomeTopic", isDirectory: true);

        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp", "DialogTopics",
                "SomeTopic - 000801_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp", "RecordData.json"),
            placement.CarrierRelativePath);
        Assert.Equal("DialogTopics", placement.Key);
    }

    [Fact]
    public void AFolderSplitLeafChild_IsAFileInItsParentsSlot_ListedInTheParentsOwnDocument()
    {
        var modFolder = Path.Combine(Path.GetTempPath(), "some-mod");
        var topicDirectory = Path.Combine(
            modFolder, "source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp", "DialogTopics", "SomeTopic - 000801_Vendor.esp");

        var placement = SourcePlacement.ForSlotChild(
            modFolder, topicDirectory, "Responses", "000802:Vendor.esp", editorId: null, isDirectory: false);

        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp", "DialogTopics",
                "SomeTopic - 000801_Vendor.esp", "Responses", "000802_Vendor.esp.json"),
            placement.RelativePath);
        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp", "DialogTopics",
                "SomeTopic - 000801_Vendor.esp", "RecordData.json"),
            placement.CarrierRelativePath);
        Assert.Equal("Responses", placement.Key);
    }

    [Fact]
    public void ARecordWithNoEditorId_IsNamedByItsFormKeyAlone()
    {
        var placement = SourcePlacement.For(Plugin, "npc_", "000800:Vendor.esp", editorId: null, Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Npcs", "000800_Vendor.esp.json"), placement.RelativePath);
    }

    [Theory]
    [InlineData("npc_", null)]
    [InlineData("weap", null)]
    [InlineData("Quest", null)]
    [InlineData("Cell", new[] { "0", "0" })]
    public void TheCarrierAlwaysSitsAboveTheRecordItNames(string recordType, string[]? blockPath)
    {
        var placement = SourcePlacement.For(Plugin, recordType, "000800:Vendor.esp", "Anything", Release, blockPath);

        var carrierDirectory = Path.GetDirectoryName(placement.CarrierRelativePath)!;
        Assert.StartsWith(carrierDirectory + Path.DirectorySeparatorChar, placement.RelativePath, StringComparison.Ordinal);
    }
}
