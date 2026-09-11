using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Tests.Serialization;

/// <summary>Zero normalization: codec bytes and the whole-mod door's file are the same bytes
/// (ADR-0007). Linux only — that door indents with <c>Environment.NewLine</c>. Tests-side because
/// Core's guard keeps the mixin out.</summary>
public sealed class DocumentShapeParityTests
{
    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    private static Fallout4Mod NewMod() => new(ModKey.FromFileName("Parity.esp"), Fallout4Release.Fallout4);

    [Fact]
    public async Task PerRecordCodecBytes_ForAnEmbeddedCell_EqualTheWholeModPathsFileForIt()
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

        await AssertBothDoorsAgree(mod, cell, "ParityCell");
    }

    [Fact]
    public async Task PerRecordCodecBytes_ForAQuest_EqualTheWholeModPathsFileForIt()
    {
        var mod = NewMod();
        var quest = MakePopulatedQuest(mod);
        mod.Quests.Add(quest);

        await AssertBothDoorsAgree(mod, quest, "ParityQuest");
    }

    [Fact]
    public async Task SerializeAsync_ForAQuest_WritesExactlyOneFileAndNoChildFolders()
    {
        var dir = Directory.CreateTempSubdirectory("medit-parity-quest-files-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "quest.json");
            await Codec().SerializeAsync(MakePopulatedQuest(NewMod()), filePath, GameRelease.Fallout4);

            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
            Assert.Empty(Directory.GetDirectories(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
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

        var dir = Directory.CreateTempSubdirectory("medit-parity-synthetic-");
        try
        {
            await MutagenJsonConverter.Instance.Serialize(mod, dir.FullName);

            var rootText = await File.ReadAllTextAsync(Path.Combine(dir.FullName, "RecordData.json"));
            Assert.Contains($"\"OverriddenForms\"", rootText, StringComparison.Ordinal);
            Assert.Contains(overriddenForm.ToString(), rootText, StringComparison.Ordinal);

            var cellGroupFile = Path.Combine(dir.FullName, "Cells", "0", "GroupRecordData.json");
            Assert.True(File.Exists(cellGroupFile), $"Expected {cellGroupFile} to exist.");
            Assert.Contains("\"LastModified\": 424242", await File.ReadAllTextAsync(cellGroupFile), StringComparison.Ordinal);

            var worldspaceFile = Directory.EnumerateFiles(dir.FullName, "RecordData.json", SearchOption.AllDirectories)
                .Single(f => f.Contains("TimestampWorldspace", StringComparison.Ordinal));
            Assert.Contains("\"SubCellsTimestamp\": 424242", await File.ReadAllTextAsync(worldspaceFile), StringComparison.Ordinal);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    private static async Task AssertBothDoorsAgree(
        Fallout4Mod mod, Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter record, string editorId)
    {
        var dir = Directory.CreateTempSubdirectory("medit-parity-");
        try
        {
            await MutagenJsonConverter.Instance.Serialize(mod, dir.FullName);

            // A directory-per-record container's RecordData.json, or a flat record's own file.
            var wholeModFile = Assert.Single(
                Directory.EnumerateDirectories(dir.FullName, $"*{editorId}*", SearchOption.AllDirectories)
                    .Select(d => Path.Combine(d, "RecordData.json"))
                    .Concat(Directory.EnumerateFiles(dir.FullName, $"*{editorId}*.json", SearchOption.AllDirectories)));
            Assert.True(File.Exists(wholeModFile), $"Expected the whole-mod door to write {wholeModFile}.");

            var wholeModBytes = await File.ReadAllBytesAsync(wholeModFile);
            var codecBytes = await Codec().SerializeToBytesAsync(record, GameRelease.Fallout4);

            Assert.Equal(
                System.Text.Encoding.UTF8.GetString(wholeModBytes),
                System.Text.Encoding.UTF8.GetString(codecBytes));
            Assert.Equal(wholeModBytes, codecBytes);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
