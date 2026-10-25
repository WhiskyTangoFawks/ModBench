using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginContainerTests : TestInstance
{
    private const string PluginName = "ContainerCompile.esp";

    private readonly PluginAddress _plugin;

    private readonly FormKey _cellA;
    private readonly FormKey _cellB;
    private readonly FormKey _cellATemporaryRef;
    private readonly FormKey _worldspace;
    private readonly FormKey _topCell;
    private readonly FormKey _exteriorCell;
    private readonly FormKey _questA;
    private readonly FormKey _questB;

    public CompilePluginContainerTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var cellA = new Cell(mod) { EditorID = "CellA", WaterHeight = 1f };
        cellA.Persistent.Add(new PlacedObject(mod) { EditorID = "A_Persist", Position = new P3Float(1f, 1f, 1f) });
        var cellATemporaryRef = new PlacedObject(mod) { EditorID = "A_Temp", Position = new P3Float(2f, 2f, 2f) };
        cellATemporaryRef.Base.SetTo(FormKey.Factory($"FFFFFF:{PluginName}"));
        cellA.Temporary.Add(cellATemporaryRef);
        var cellB = new Cell(mod) { EditorID = "CellB", WaterHeight = 2f };
        cellB.Persistent.Add(new PlacedObject(mod) { EditorID = "B_Persist", Position = new P3Float(3f, 3f, 3f) });
        cellB.Temporary.Add(new PlacedObject(mod) { EditorID = "B_Temp", Position = new P3Float(4f, 4f, 4f) });
        mod.AddInteriorCells(cellA, cellB);

        var worldspace = new Worldspace(mod) { EditorID = "CompileWorld" };
        var topCell = new Cell(mod) { EditorID = "WorldTopCell", WaterHeight = 3f };
        topCell.Temporary.Add(new PlacedObject(mod) { EditorID = "Top_Temp", Position = new P3Float(5f, 5f, 5f) });
        worldspace.TopCell = topCell;

        var exteriorCell = new Cell(mod) { EditorID = "ExteriorCell", WaterHeight = 4f, Grid = new CellGrid { Point = new P2Int(3, -4) } };
        exteriorCell.Temporary.Add(new PlacedObject(mod) { EditorID = "Ext_Temp", Position = new P3Float(6f, 6f, 6f) });
        var worldSubBlock = new WorldspaceSubBlock
        {
            BlockNumberX = 3,
            BlockNumberY = -4,
            GroupType = GroupTypeEnum.ExteriorCellSubBlock,
        };
        worldSubBlock.Items.Add(exteriorCell);
        var worldBlock = new WorldspaceBlock
        {
            BlockNumberX = 0,
            BlockNumberY = -1,
            GroupType = GroupTypeEnum.ExteriorCellBlock,
        };
        worldBlock.Items.Add(worldSubBlock);
        worldspace.SubCells.Add(worldBlock);
        mod.Worldspaces.Add(worldspace);

        var questA = new Quest(mod) { EditorID = "QuestA" };
        var topicA = new DialogTopic(mod) { EditorID = "TopicA" };
        topicA.Responses.Add(new DialogResponses(mod) { EditorID = "ResponseA" });
        questA.DialogTopics.Add(topicA);
        questA.Scenes.Add(new Scene(mod) { EditorID = "SceneA" });
        mod.Quests.Add(questA);

        var questB = new Quest(mod) { EditorID = "QuestB" };
        var topicB = new DialogTopic(mod) { EditorID = "TopicB" };
        topicB.Responses.Add(new DialogResponses(mod) { EditorID = "ResponseB" });
        questB.DialogTopics.Add(topicB);
        mod.Quests.Add(questB);

        _plugin = Add(mod, "ContainerCompileMod");
        (_cellA, _cellB, _cellATemporaryRef) = (cellA.FormKey, cellB.FormKey, cellATemporaryRef.FormKey);
        (_worldspace, _topCell, _exteriorCell) = (worldspace.FormKey, topCell.FormKey, exteriorCell.FormKey);
        (_questA, _questB) = (questA.FormKey, questB.FormKey);
    }

    private static IEnumerable<ICellGetter> AllCells(IFallout4ModGetter mod) =>
        mod.EnumerateMajorRecords<ICellGetter>();

    [Fact]
    public async Task Compile_OfTwoCellsInOneSubBlock_GivesEachCellExactlyItsOwnChildren()
    {
        using var mod = await this.CompiledAsync(_plugin);

        var a = AllCells(mod).Single(c => c.FormKey == _cellA);
        var b = AllCells(mod).Single(c => c.FormKey == _cellB);

        Assert.Equal(["A_Persist"], [.. a.Persistent.Select(r => r.EditorID.Require()).Order()]);
        Assert.Equal(["A_Temp"], [.. a.Temporary.Select(r => r.EditorID.Require()).Order()]);
        Assert.Equal(["B_Persist"], [.. b.Persistent.Select(r => r.EditorID.Require()).Order()]);
        Assert.Equal(["B_Temp"], [.. b.Temporary.Select(r => r.EditorID.Require()).Order()]);
    }

    [Fact]
    public async Task Compile_OfAWorldspace_KeepsTheExteriorHierarchyAndTheTopCell()
    {
        using var mod = await this.CompiledAsync(_plugin);

        var worldspace = mod.Worldspaces.Single(w => w.FormKey == _worldspace);

        Assert.NotNull(worldspace.TopCell);
        Assert.Equal(_topCell, worldspace.TopCell.Require().FormKey);
        Assert.Equal(["Top_Temp"], [.. worldspace.TopCell.Temporary.Select(r => r.EditorID.Require())]);

        var writtenBlock = Assert.Single(worldspace.SubCells);
        Assert.Equal(0, writtenBlock.BlockNumberX);
        Assert.Equal(-1, writtenBlock.BlockNumberY);
        var writtenSubBlock = Assert.Single(writtenBlock.Items);
        Assert.Equal(3, writtenSubBlock.BlockNumberX);
        Assert.Equal(-4, writtenSubBlock.BlockNumberY);

        var cell = Assert.Single(writtenSubBlock.Items);
        Assert.Equal(_exteriorCell, cell.FormKey);
        Assert.Equal(new P2Int(3, -4), cell.Grid.Require().Point);
        Assert.Equal(["Ext_Temp"], [.. cell.Temporary.Select(r => r.EditorID.Require())]);
    }

    [Fact]
    public async Task Compile_OfTwoQuests_GivesEachQuestExactlyItsOwnDialogueAndScenes()
    {
        using var mod = await this.CompiledAsync(_plugin);

        var a = mod.Quests.Single(q => q.FormKey == _questA);
        var b = mod.Quests.Single(q => q.FormKey == _questB);

        Assert.Equal(["TopicA"], [.. a.DialogTopics.Select(t => t.EditorID.Require()).Order()]);
        Assert.Equal(["TopicB"], [.. b.DialogTopics.Select(t => t.EditorID.Require()).Order()]);
        Assert.Equal(["SceneA"], [.. a.Scenes.Select(s => s.EditorID.Require()).Order()]);
        Assert.Empty(b.Scenes);

        Assert.Equal(
            ["ResponseA"],
            [.. a.DialogTopics.Single().Responses.Select(r => r.EditorID.Require()).Order()]);
        Assert.Equal(
            ["ResponseB"],
            [.. b.DialogTopics.Single().Responses.Select(r => r.EditorID.Require()).Order()]);
    }

    [Fact]
    public async Task Compile_ForAnEmbeddedChildWithASemanticError_NamesTheContainersOwnDocument()
    {
        var answer = (await CompileHandler.CompileAsync([_plugin])).Value();
        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;

        var diagnostic = Assert.Single(diagnostics, d => d.FormKey == _cellATemporaryRef.ToString());

        var cell = SourceModTree.DocumentCarrying(ModFolderOf(_plugin), _plugin, "CellA");
        Assert.Equal(
            TreeTampering.FileOf(ModFolderOf(_plugin), _plugin, new RecordIdentity(cell.FormKey, cell.RecordType, cell.EditorId)),
            Path.Combine(ModFolderOf(_plugin), diagnostic.SourceRelativePath));
    }

}
