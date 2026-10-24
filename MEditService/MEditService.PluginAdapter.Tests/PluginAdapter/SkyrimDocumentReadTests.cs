using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Assets;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Skyrim.Assets;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class SkyrimDocumentReadTests
{
    private const string PluginName = "Skyrim.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    [Fact]
    public void OpenDocuments_ReadsEverySkyrimRecord_EachContainerWithTheChildrenItsGrupHolds()
    {
        using var scratch = new ScratchDirectory("documents-skyrim");
        var mod = new SkyrimMod(ModKey.FromFileName(PluginName), SkyrimRelease.SkyrimSE);
        var quest = mod.Quests.AddNew("SkyrimQuest");
        var topic = mod.DialogTopics.AddNew("SkyrimTopic");
        topic.Quest.SetTo(quest);
        var response = new DialogResponses(mod);
        topic.Responses.Add(response);
        var cell = new Cell(mod) { EditorID = "SkyrimCell" };
        var placed = new PlacedObject(mod);
        cell.Temporary.Add(placed);
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
        var textures = mod.TextureSets.AddNew("SkyrimTextures");
        textures.Diffuse = new AssetLink<SkyrimTextureAssetType>(@"textures\skyrim\diffuse.dds");
        var path = Path.Combine(scratch.Path, PluginName);
        mod.WriteToBinary(path);

        using var documents = Adapter.OpenDocuments(
            new ModPath(mod.ModKey, path), EmptyLoadOrder.Of(GameRelease.SkyrimSE), SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE), PluginStrings.None).Answered();
        var records = documents.Records.ToList();

        Assert.Equal(
            [.. new[] { quest.FormKey, topic.FormKey, response.FormKey, cell.FormKey, placed.FormKey, textures.FormKey }.Select(k => k.ToString()).Order(StringComparer.Ordinal)],
            records.Select(r => r.FormKey).Order(StringComparer.Ordinal));
        Assert.All(records, r => Assert.Null(r.ParseDiagnosis));
        Assert.Equal([new ChildRecord(response.FormKey.ToString(), "Responses", 0)], records.Single(r => r.FormKey == topic.FormKey.ToString()).Contents ?? []);
        Assert.Equal([new ChildRecord(placed.FormKey.ToString(), "Temporary", 0)], records.Single(r => r.FormKey == cell.FormKey.ToString()).Contents ?? []);
        Assert.Contains(@"textures\\skyrim\\diffuse.dds", records.Single(r => r.FormKey == textures.FormKey.ToString()).Text, StringComparison.Ordinal);
    }
}
