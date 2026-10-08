using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginDocumentReadTests
{
    private const string PluginName = "Documents.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    [Fact]
    public void OpenDocuments_YieldsEachRecordAsTheCodecsOwnText_UnderItsSchemaTableName()
    {
        using var data = new PluginFixtureBuilder("documents-read")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("DocumentNpc"))
            .Build();
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);
        var npc = documents.Records.Single(d => d.RecordType == "npc_");

        using var loaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(PluginName), path), Fallout4Release.Fallout4);
        var expected = RecordTextCodec.SerializeToText(loaded.EnumerateMajorRecords().Single(), GameRelease.Fallout4);

        Assert.Equal(expected, npc.Text);
        Assert.Equal(loaded.EnumerateMajorRecords().Single().FormKey.ToString(), npc.FormKey);
        Assert.Null(npc.ParseDiagnosis);
    }

    [Fact]
    public void OpenDocuments_YieldsThePluginHeaderAsTheWholeModDoorsRootDocument()
    {
        using var data = new PluginFixtureBuilder("documents-header")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("DocumentNpc"))
            .Build();
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);

        Assert.Equal(PluginHeader.RecordType, documents.Header.RecordType);
        Assert.Equal($"000000:{PluginName}", documents.Header.FormKey);
        Assert.Contains("ModHeader", documents.Header.Text, StringComparison.Ordinal);
        Assert.DoesNotContain(documents.Records, d => d.RecordType == PluginHeader.RecordType);
    }

    [Fact]
    public void OpenDocuments_YieldsARecordTheCodecCannotRead_AsItsIdentityAndItsDiagnosis()
    {
        using var scratch = new ScratchDirectory("documents-unreadable-perk");
        MisshapedPerkPlugin.Plugin.WriteInto(scratch.Path);
        var path = Path.Combine(scratch.Path, MisshapedPerkPlugin.FileName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(MisshapedPerkPlugin.FileName), path), GameRelease.Fallout4, Schemas);
        var perks = documents.Records.Where(d => d.RecordType == "perk").ToList();

        var unreadable = perks.Single(d => d.FormKey == MisshapedPerkPlugin.FormKey);
        Assert.NotNull(unreadable.ParseDiagnosis);
        Assert.Contains("did not have expected parameter type flag", unreadable.ParseDiagnosis);

        using var stub = JsonDocument.Parse(unreadable.Text);
        Assert.Equal(
            ["FormKey", "EditorID"],
            stub.RootElement.EnumerateObject().Select(p => p.Name).ToList());

        Assert.All(perks.Where(d => d.FormKey != MisshapedPerkPlugin.FormKey), d => Assert.Null(d.ParseDiagnosis));
    }

    [Fact]
    public void OpenDocuments_GivesACellTheBlockCoordinatesItsGrupHierarchyPutsItAt()
    {
        using var data = CellFixture("documents-cell", out var extCellFormKey);
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);
        var cell = documents.Records.Single(d => d.RecordType == "cell" && d.FormKey == extCellFormKey);

        Assert.Equal(new CellStructure("000800:Documents.esp", 3, 4, 1, 2, IsInterior: false), cell.Cell);
    }

    [Fact]
    public void OpenDocuments_GivesACellEveryChildRecordItsGrupHolds_BesideItsDocument()
    {
        using var data = CellFixture("documents-contents", out var extCellFormKey);
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);
        var cell = documents.Records.Single(d => d.RecordType == "cell" && d.FormKey == extCellFormKey);

        Assert.NotNull(cell.Contents);
        Assert.Equal(
            [
                new ChildRecord("000802:Documents.esp", "Persistent", 0),
                new ChildRecord("000803:Documents.esp", "Temporary", 0),
                new ChildRecord("000804:Documents.esp", "Landscape", 0),
                new ChildRecord("000805:Documents.esp", "NavigationMeshes", 0),
            ],
            cell.Contents.OrderBy(c => c.FormKey, StringComparer.Ordinal));
    }

    [Fact]
    public void OpenDocuments_GivesAQuestEveryChildRecordItsGrupHolds_BesideItsDocument()
    {
        string questFormKey = "", topicFormKey = "";
        using var data = new PluginFixtureBuilder("documents-quest-contents")
            .WithPlugin(PluginName, mod =>
            {
                var quest = mod.Quests.AddNew("DocumentQuest");
                var topic = new DialogTopic(mod) { EditorID = "DocumentTopic" };
                quest.DialogTopics.Add(topic);
                (questFormKey, topicFormKey) = (quest.FormKey.ToString(), topic.FormKey.ToString());
            })
            .Build();
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);
        var quest = documents.Records.Single(d => d.RecordType == "qust" && d.FormKey == questFormKey);

        Assert.Equal([new ChildRecord(topicFormKey, "DialogTopics", 0)], quest.Contents ?? []);
    }

    private static PluginFixtureData CellFixture(string prefix, out string extCellFormKey)
    {
        var formKey = string.Empty;
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin(PluginName, mod =>
            {
                var worldspace = mod.Worldspaces.AddNew("DocumentWorld");
                var cell = new Cell(mod) { EditorID = "DocumentCell" };
                formKey = cell.FormKey.ToString();
                cell.Persistent.Add(new PlacedObject(mod) { EditorID = "kept" });
                cell.Temporary.Add(new PlacedArrow(mod) { EditorID = "arrow" });
                cell.Landscape = new Landscape(mod);
                cell.NavigationMeshes.Add(new NavigationMesh(mod));
                var subBlock = new WorldspaceSubBlock { BlockNumberX = 1, BlockNumberY = 2 };
                subBlock.Items.Add(cell);
                var block = new WorldspaceBlock { BlockNumberX = 3, BlockNumberY = 4 };
                block.Items.Add(subBlock);
                worldspace.SubCells.Add(block);
            })
            .Build();
        extCellFormKey = formKey;
        return data;
    }
}
