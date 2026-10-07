using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentShapeParityTests
{
    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    private static Fallout4Mod NewMod() => new(ModKey.FromFileName("Parity.esp"), Fallout4Release.Fallout4);

    [Fact]
    public async Task PerRecordCodecBytes_ForAnEmbeddedCell_EqualTheWholeModPathsFileForIt_WithZeroNormalizationOnLinuxWhereThatDoorIndentsWithEnvironmentNewLine()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "ParityCell" };
        cell.Persistent.Add(new PlacedObject(mod) { EditorID = "Parity_Persistent" });
        cell.Temporary.Add(new PlacedObject(mod) { EditorID = "Parity_Temporary" });
        cell.NavigationMeshes.Add(new NavigationMesh(mod) { EditorID = "Parity_Navmesh" });
        cell.Landscape = new Landscape(mod) { EditorID = "Parity_Landscape" };

        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        await AssertBothDoorsAgreeTestsSideBecauseCoresGuardKeepsTheMixinOut(mod, cell, "ParityCell");
    }

    [Fact]
    public async Task PerRecordCodecBytes_ForAQuest_EqualTheWholeModPathsFileForIt_WithZeroNormalizationOnLinuxWhereThatDoorIndentsWithEnvironmentNewLine()
    {
        var mod = NewMod();
        var quest = MakePopulatedQuest(mod);
        mod.Quests.Add(quest);

        await AssertBothDoorsAgreeTestsSideBecauseCoresGuardKeepsTheMixinOut(mod, quest, "ParityQuest");
    }

    [Fact]
    public void SerializeToText_ForAQuest_CarriesItsTopicAndItsResponseInline()
    {
        using var doc = JsonDocument.Parse(Codec().SerializeToText(MakePopulatedQuest(NewMod()), GameRelease.Fallout4));

        var topic = doc.RootElement.GetProperty("DialogTopics")[0];
        Assert.Equal("ParityTopic", topic.GetProperty("EditorID").GetString());
        Assert.Equal("ParityResponse", topic.GetProperty("Responses")[0].GetProperty("EditorID").GetString());
    }

    private static Quest MakePopulatedQuest(Fallout4Mod mod)
    {
        var quest = new Quest(mod) { EditorID = "ParityQuest", Name = "Parity Quest" };
        var topic = new DialogTopic(mod) { EditorID = "ParityTopic" };
        topic.Responses.Add(new DialogResponses(mod) { EditorID = "ParityResponse" });
        quest.DialogTopics.Add(topic);
        return quest;
    }

    [Fact]
    public async Task Serialize_OfASyntheticModWithNonDefaultGroupAndHeaderFields_WritesThemUnomitted()
    {
        var mod = NewMod();
        var overriddenForm = new FormKey(ModKey.FromFileName("Test.esm"), 0x001);
        mod.ModHeader.SetOverriddenForms([overriddenForm]);

        var cell = new Cell(mod) { EditorID = "TimestampCell" };
        var subBlock = new CellSubBlock { BlockNumber = 0, LastModified = 424242 };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, LastModified = 424242 };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
        mod.Cells.LastModified = 424242;

        var worldspace = mod.Worldspaces.AddNew();
        worldspace.EditorID = "TimestampWorldspace";
        worldspace.SubCellsTimestamp = 424242;

        using var dir = new ScratchDirectory("medit-parity-synthetic-");
        await MutagenJsonConverter.Instance.Serialize(mod, dir.Path);

        var rootText = await File.ReadAllTextAsync(Path.Combine(dir.Path, "RecordData.json"));
        Assert.Contains($"\"OverriddenForms\"", rootText, StringComparison.Ordinal);
        Assert.Contains(overriddenForm.ToString(), rootText, StringComparison.Ordinal);

        var cellGroupFile = Path.Combine(dir.Path, "Cells", "0", "GroupRecordData.json");
        Assert.True(File.Exists(cellGroupFile), $"Expected {cellGroupFile} to exist.");
        Assert.Contains("\"LastModified\": 424242", await File.ReadAllTextAsync(cellGroupFile), StringComparison.Ordinal);

        var worldspaceFile = Directory.EnumerateFiles(dir.Path, "RecordData.json", SearchOption.AllDirectories)
            .Single(f => f.Contains("TimestampWorldspace", StringComparison.Ordinal));
        Assert.Contains("\"SubCellsTimestamp\": 424242", await File.ReadAllTextAsync(worldspaceFile), StringComparison.Ordinal);
    }

    private static async Task AssertBothDoorsAgreeTestsSideBecauseCoresGuardKeepsTheMixinOut(
        Fallout4Mod mod, Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter record, string editorId)
    {
        using var dir = new ScratchDirectory("medit-parity-");
        await MutagenJsonConverter.Instance.Serialize(mod, dir.Path);

        var directoryPerRecordContainersRecordDataJsonOrAFlatRecordsOwnFile = Directory.EnumerateDirectories(dir.Path, $"*{editorId}*", SearchOption.AllDirectories)
            .Select(d => Path.Combine(d, "RecordData.json"))
            .Concat(Directory.EnumerateFiles(dir.Path, $"*{editorId}*.json", SearchOption.AllDirectories));
        var wholeModFile = Assert.Single(directoryPerRecordContainersRecordDataJsonOrAFlatRecordsOwnFile);
        Assert.True(File.Exists(wholeModFile), $"Expected the whole-mod door to write {wholeModFile}.");

        var wholeModBytes = await File.ReadAllBytesAsync(wholeModFile);
        var codecText = Codec().SerializeToText(record, GameRelease.Fallout4);

        Assert.Equal(System.Text.Encoding.UTF8.GetString(wholeModBytes), codecText);
        Assert.Equal(wholeModBytes, System.Text.Encoding.UTF8.GetBytes(codecText));
    }
}
