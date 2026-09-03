using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// One answer to "where does a record of this type go, and which ordered child list names it there".
///
/// <para>Those two questions were previously answered in four places that had to agree without
/// anything making them — <c>SourceRecordPath.For</c>, <c>ContainerOwnDirectoryPath</c>,
/// <c>InteriorCellDestinationPath</c> and a private <c>AddToOwnGroupOrder</c> whose key came from an
/// <c>isFlat</c> cascade with a stringly-typed <c>"cell"</c> override bolted on. Every caller had to
/// pick the right pair, and a Cell picked differently from everything else. This is the pair, derived
/// once.</para>
///
/// <para>The three shapes below are the whole taxonomy, and they are the reason the old cascade
/// existed: a flat record is a file in its group folder; a top-level container is a directory in its
/// group folder; an interior Cell is a directory nested under a block/sub-block pair, so the list that
/// names it belongs to the sub-block rather than to the group.</para>
/// </summary>
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
        var placement = SourcePlacement.For(Plugin, "quest", "000800:Vendor.esp", "SomeQuest", Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Quests", "SomeQuest - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
        Assert.Equal(Path.Combine("source", Plugin, "Quests", "GroupRecordData.json"), placement.CarrierRelativePath);
        Assert.Equal("Quests", placement.Key);
    }

    /// <summary>The one shape whose carrier is not its group folder's: an interior Cell nests under a
    /// block and sub-block, so the list naming it is the sub-block's own, keyed by the sub-block's
    /// member rather than by the group folder. This is the case the old code expressed as a
    /// stringly-typed override.</summary>
    [Fact]
    public void AnInteriorCell_NestsUnderABlockPair_ListedUnderTheSubBlocksOwnMember()
    {
        var placement = SourcePlacement.For(Plugin, "cell", "000800:Vendor.esp", "SomeCell", Release, blockPath: ["0", "0"]);

        Assert.Equal(
            Path.Combine("source", Plugin, "Cells", "0", "0", "SomeCell - 000800_Vendor.esp", "RecordData.json"),
            placement.RelativePath);
        Assert.Equal(
            Path.Combine("source", Plugin, "Cells", "0", "0", "GroupRecordData.json"),
            placement.CarrierRelativePath);
        Assert.Equal("Cells", placement.Key);
    }

    /// <summary>The fourth shape, and the one <see cref="SourcePlacement.For"/> refuses: a folder-split
    /// child has no group folder of its own. It lives in a slot directory under its parent's own
    /// directory, and the list naming it is the parent's <c>RecordData.json</c> keyed by the slot —
    /// a DialogTopic under a Quest, a Response under a DialogTopic. A container child (DialogTopic)
    /// is a directory with its fields in <c>RecordData.json</c>; a leaf child (Response) is a file.
    /// Before this existed, six call sites each composed the pair by hand.</summary>
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

    /// <summary>A record with no EditorID is named by its FormKey alone — the whole-mod door's own
    /// second name shape, and the reason nothing may split a leaf on <c>" - "</c> to recover
    /// identity.</summary>
    [Fact]
    public void ARecordWithNoEditorId_IsNamedByItsFormKeyAlone()
    {
        var placement = SourcePlacement.For(Plugin, "npc_", "000800:Vendor.esp", editorId: null, Release);

        Assert.Equal(
            Path.Combine("source", Plugin, "Npcs", "000800_Vendor.esp.json"), placement.RelativePath);
    }

    /// <summary>The carrier and the record always sit in the same subtree — the invariant that lets a
    /// caller hand the placement to both the writer and the ordered-child-list update without
    /// re-deriving either.</summary>
    [Theory]
    [InlineData("npc_", null)]
    [InlineData("weap", null)]
    [InlineData("quest", null)]
    [InlineData("cell", new[] { "0", "0" })]
    public void TheCarrierAlwaysSitsAboveTheRecordItNames(string recordType, string[]? blockPath)
    {
        var placement = SourcePlacement.For(Plugin, recordType, "000800:Vendor.esp", "Anything", Release, blockPath);

        var carrierDirectory = Path.GetDirectoryName(placement.CarrierRelativePath)!;
        Assert.StartsWith(carrierDirectory + Path.DirectorySeparatorChar, placement.RelativePath, StringComparison.Ordinal);
    }
}
