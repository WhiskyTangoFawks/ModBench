using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>The container spike's three container shapes, compiled and re-imported. Nothing
/// here asserts child ordering, on purpose: the real-fixture gates cover it, and this fixture only
/// ever needed the child set.</summary>
public sealed class PluginCompileServiceContainerTests : IDisposable
{
    private const string PluginName = "ContainerCompile.esp";
    private const string Origin = "ContainerCompileMod";

    // Header fields with values nothing derives — a compile that emitted a fresh header instead of the
    // tree's own root RecordData.json would leave both null.
    private const string HeaderAuthor = "CompileHeaderAuthor";
    private const string HeaderDescription = "Header carried from the source tree.";
    private const string TopicC1EditorId = "TopicC1";
    private const string TopicC2EditorId = "TopicC2";
    private const string TopicC3EditorId = "TopicC3";

    private const string QuestRecordType = "quest";

    private readonly string _modFolder;
    private readonly string _gameDirectory;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginCopyKey _plugin = new(PluginName, Origin);

    private readonly FormKey _cellA;
    private readonly FormKey _cellB;
    private readonly FormKey _cellATemporaryRef;
    private readonly FormKey _worldspace;
    private readonly FormKey _topCell;
    private readonly FormKey _exteriorCell;
    private readonly FormKey _questA;
    private readonly FormKey _questB;
    private readonly FormKey _questC;
    private readonly FormKey _topicC2;

    public PluginCompileServiceContainerTests()
    {
        _modFolder = Directory.CreateTempSubdirectory("medit-container-compile-").FullName;
        _gameDirectory = Directory.CreateTempSubdirectory("medit-container-compile-game-").FullName;

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.ModHeader.Author = HeaderAuthor;
        mod.ModHeader.Description = HeaderDescription;

        // ── Defect shape 1: two cells in ONE sub-block, each with children. Under the per-record path
        //
        // both cells' children landed in one field-name-keyed directory and each cell read back the
        // union.
        var cellA = new Cell(mod) { EditorID = "CellA", WaterHeight = 1f };
        cellA.Persistent.Add(new PlacedObject(mod) { EditorID = "A_Persist", Position = new P3Float(1f, 1f, 1f) });
        var cellATemporaryRef = new PlacedObject(mod) { EditorID = "A_Temp", Position = new P3Float(2f, 2f, 2f) };
        // A deliberately dangling Base, inside this plugin's own FormID space so it needs no master:
        // semantic breakage that compiles with a diagnostic rather than refusing.
        cellATemporaryRef.Base.SetTo(FormKey.Factory($"FFFFFF:{PluginName}"));
        cellA.Temporary.Add(cellATemporaryRef);
        var cellB = new Cell(mod) { EditorID = "CellB", WaterHeight = 2f };
        cellB.Persistent.Add(new PlacedObject(mod) { EditorID = "B_Persist", Position = new P3Float(3f, 3f, 3f) });
        cellB.Temporary.Add(new PlacedObject(mod) { EditorID = "B_Temp", Position = new P3Float(4f, 4f, 4f) });

        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cellA);
        subBlock.Cells.Add(cellB);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        // ── Defect shape 2: the worldspace's whole exterior XY hierarchy, plus its TopCell.
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

        // ── The spike's third probe: two quests, each with its own dialogue, all inline.
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

        // Three topics in one slot, so a delete of the middle one has an order to keep.
        var questC = new Quest(mod) { EditorID = "QuestC" };
        var topicC2 = new DialogTopic(mod) { EditorID = TopicC2EditorId };
        questC.DialogTopics.Add(new DialogTopic(mod) { EditorID = TopicC1EditorId });
        questC.DialogTopics.Add(topicC2);
        questC.DialogTopics.Add(new DialogTopic(mod) { EditorID = TopicC3EditorId });
        mod.Quests.Add(questC);
        (_questC, _topicC2) = (questC.FormKey, topicC2.FormKey);

        mod.WriteToBinary(pluginPath);
        (_cellA, _cellB, _cellATemporaryRef) = (cellA.FormKey, cellB.FormKey, cellATemporaryRef.FormKey);
        (_worldspace, _topCell, _exteriorCell) = (worldspace.FormKey, topCell.FormKey, exteriorCell.FormKey);
        (_questA, _questB) = (questA.FormKey, questB.FormKey);

        _loadOrder = new LoadOrderSnapshot(
            _gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));

        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackAsync(_loadOrder, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private PluginCompileService CompileService() => CompileServices.Over(_loadOrder);

    private async Task<(IFallout4ModGetter Mod, IDisposable Handle)> CompileAndReimport()
    {
        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        return ((IFallout4ModGetter)overlay, overlay);
    }

    private static IEnumerable<ICellGetter> AllCells(IFallout4ModGetter mod) =>
        mod.EnumerateMajorRecords<ICellGetter>();

    [Fact]
    public async Task Compile_OfTwoCellsInOneSubBlock_GivesEachCellExactlyItsOwnChildren()
    {
        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            var a = AllCells(mod).Single(c => c.FormKey == _cellA);
            var b = AllCells(mod).Single(c => c.FormKey == _cellB);

            Assert.Equal(["A_Persist"], a.Persistent.Select(r => r.EditorID.Require()).Order().ToArray());
            Assert.Equal(["A_Temp"], a.Temporary.Select(r => r.EditorID.Require()).Order().ToArray());
            Assert.Equal(["B_Persist"], b.Persistent.Select(r => r.EditorID.Require()).Order().ToArray());
            Assert.Equal(["B_Temp"], b.Temporary.Select(r => r.EditorID.Require()).Order().ToArray());
        }
    }

    [Fact]
    public async Task Compile_OfAWorldspace_KeepsTheExteriorHierarchyAndTheTopCell()
    {
        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            var worldspace = mod.Worldspaces.Single(w => w.FormKey == _worldspace);

            Assert.NotNull(worldspace.TopCell);
            Assert.Equal(_topCell, worldspace.TopCell.Require().FormKey);
            Assert.Equal(["Top_Temp"], worldspace.TopCell.Temporary.Select(r => r.EditorID.Require()).ToArray());

            var writtenBlock = Assert.Single(worldspace.SubCells);
            Assert.Equal(0, writtenBlock.BlockNumberX);
            Assert.Equal(-1, writtenBlock.BlockNumberY);
            var writtenSubBlock = Assert.Single(writtenBlock.Items);
            Assert.Equal(3, writtenSubBlock.BlockNumberX);
            Assert.Equal(-4, writtenSubBlock.BlockNumberY);

            var cell = Assert.Single(writtenSubBlock.Items);
            Assert.Equal(_exteriorCell, cell.FormKey);
            Assert.Equal(new P2Int(3, -4), cell.Grid.Require().Point);
            Assert.Equal(["Ext_Temp"], cell.Temporary.Select(r => r.EditorID.Require()).ToArray());
        }
    }

    [Fact]
    public async Task Compile_OfTwoQuests_GivesEachQuestExactlyItsOwnDialogueAndScenes()
    {
        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            var a = mod.Quests.Single(q => q.FormKey == _questA);
            var b = mod.Quests.Single(q => q.FormKey == _questB);

            Assert.Equal(["TopicA"], a.DialogTopics.Select(t => t.EditorID.Require()).Order().ToArray());
            Assert.Equal(["TopicB"], b.DialogTopics.Select(t => t.EditorID.Require()).Order().ToArray());
            Assert.Equal(["SceneA"], a.Scenes.Select(s => s.EditorID.Require()).Order().ToArray());
            Assert.Empty(b.Scenes);

            Assert.Equal(
                ["ResponseA"],
                a.DialogTopics.Single().Responses.Select(r => r.EditorID.Require()).Order().ToArray());
            Assert.Equal(
                ["ResponseB"],
                b.DialogTopics.Single().Responses.Select(r => r.EditorID.Require()).Order().ToArray());
        }
    }

    [Fact]
    public async Task Compile_ForAnEmbeddedChildWithASemanticError_NamesTheContainersOwnSourceFile()
    {
        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var diagnostic = Assert.Single(
            result.Diagnostics.Where(d => d.FormKey == _cellATemporaryRef.ToString()).Take(1));

        var full = Path.Combine(_modFolder, diagnostic.SourceRelativePath);
        Assert.True(File.Exists(full), $"'{diagnostic.SourceRelativePath}' is not a file in the tree.");
        Assert.Equal("RecordData.json", Path.GetFileName(full));
        Assert.Contains("\"CellA\"", File.ReadAllText(full), StringComparison.Ordinal);
    }

    // A container's document is found by scanning the tree, never computed from the identity, so the
    // ref's own answer is the only one left once the working tree has lost the directory.
    [Fact]
    public async Task Compile_AtARef_ForAnEmbeddedChildWithASemanticError_NamesTheContainersDocumentInThatRef()
    {
        var cellDirectory = Directory
            .EnumerateDirectories(
                Path.Combine(_modFolder, SourceRepository.RootFor(PluginName)), "CellA*", SearchOption.AllDirectories)
            .Single();
        Directory.Delete(cellDirectory, recursive: true);

        var result = await CompileService().CompileAsync(_plugin, new CompileSource.AtRef("HEAD"));

        Assert.True(result.Succeeded, result.RefusalReason);
        var diagnostic = result.Diagnostics.First(d => d.FormKey == _cellATemporaryRef.ToString());
        Assert.Equal(
            Path.Combine(Path.GetRelativePath(_modFolder, cellDirectory), "RecordData.json"),
            diagnostic.SourceRelativePath);
        Assert.False(File.Exists(Path.Combine(_modFolder, diagnostic.SourceRelativePath)));
    }

    [Fact]
    public async Task Compile_AfterDeletingTheMiddleOfThreeDialogTopics_Succeeds_KeepingSurvivorsInOrder()
    {
        SourceEdits.Rewrite<Quest>(
            SourceRepository.Open(_modFolder, GameRelease.Fallout4).Require(), _plugin,
            new RecordIdentity(_questC.ToString(), QuestRecordType, "QuestC"), GameRelease.Fallout4,
            quest => quest.DialogTopics.Remove(quest.DialogTopics.Single(t => t.FormKey == _topicC2)));

        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            var questC = mod.Quests.Single(q => q.FormKey == _questC);
            Assert.Equal(
                [TopicC1EditorId, TopicC3EditorId],
                questC.DialogTopics.Select(t => t.EditorID.Require()).ToArray());
        }
    }

    [Fact]
    public async Task Compile_CarriesTheModHeaderFromTheTree_RatherThanEmittingAFreshOne()
    {
        var (mod, handle) = await CompileAndReimport();
        using (handle)
        {
            Assert.Equal(HeaderAuthor, mod.ModHeader.Author);
            Assert.Equal(HeaderDescription, mod.ModHeader.Description);
        }
    }
}
