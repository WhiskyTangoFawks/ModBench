using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two mod folders, because one cannot ask whether a copy crosses plugins. The source
/// defaults untracked, so its records come through the Plugin adapter; no index anywhere in
/// it.</summary>
public sealed class ContainerCopyFixture : TestInstance, ITrackedPlugins
{
    public const string SourcePluginName = "ContainerSource.esm";
    public const string SourceOrigin = "ContainerSourceMod";
    public const string DestinationPluginName = "ContainerDestination.esp";
    public const string DestinationOrigin = "ContainerDestinationMod";

    public string SourceModFolder => FolderOf(SourceOrigin);
    public string DestinationModFolder => FolderOf(DestinationOrigin);
    public PluginAddress SourcePlugin { get; }
    public PluginAddress DestinationPlugin { get; }

    public const string DestinationNpcEditorId = "DestinationNpc";
    public FormKey DestinationNpc { get; }

    public const string QuestEditorId = "SourceQuest";
    public FormKey Quest { get; }

    // A flat record in the source — the negative control for the container-only overwrite scope
    // (a flat re-copy keeps the FormKeyCollision refusal).
    public const string FlatNpcEditorId = "SourceFlatNpc";
    public FormKey FlatNpc { get; }

    public const string DialogTopicEditorId = "SourceTopic";
    public FormKey DialogTopic { get; }

    // Two responses under the topic: DIAL with INFOs. Response1 links to itself, Response2 to Response1.
    public const string Response1EditorId = "SourceResponse1";
    public FormKey Response1 { get; }

    public const string Response2EditorId = "SourceResponse2";
    public FormKey Response2 { get; }

    public const string SceneEditorId = "SourceScene";
    public FormKey Scene { get; }

    public const string DialogBranchEditorId = "SourceBranch";
    public FormKey DialogBranch { get; }

    public const string ChildlessQuestEditorId = "SourceChildlessQuest";
    public FormKey ChildlessQuest { get; }

    public const string BareQuestEditorId = "SourceBareQuest";
    public FormKey BareQuest { get; }

    public const string BareTopicEditorId = "SourceBareTopic";
    public FormKey BareTopic { get; }

    // Interior — the non-spatial case: a real block/sub-block pair.
    public const string InteriorCellEditorId = "SourceInteriorCell";
    public const float InteriorCellWaterHeight = 100f;
    public FormKey InteriorCell { get; }

    public const string PersistentRefEditorId = "SourcePersistentRef";
    public FormKey PersistentRef { get; }

    public const string TemporaryRefEditorId = "SourceTemporaryRef";
    public FormKey TemporaryRef { get; }

    public const string NavmeshEditorId = "SourceNavmesh";
    public FormKey Navmesh { get; }

    public const string LandscapeEditorId = "SourceLandscape";
    public FormKey Landscape { get; }

    // TopCell is a worldspace's persistent cell: embedded in the worldspace's document, with no grid.
    public const string WorldspaceEditorId = "SourceWorld";
    public FormKey Worldspace { get; }

    public const string TopCellEditorId = "SourceTopCell";
    public FormKey TopCell { get; }

    public const string TopCellRefEditorId = "SourceTopCellRef";
    public FormKey TopCellRef { get; }

    // A real SubCells cell: each cell's block and sub-block are the ones its own grid falls in.
    public const int ExteriorBlockX = 0;
    public const int ExteriorBlockY = -1;
    public const int ExteriorSubX = 0;
    public const int ExteriorSubY = -1;
    public const int ExteriorGridX = 1;
    public const int ExteriorGridY = -2;

    public const string ExteriorCellEditorId = "SourceExteriorCell";
    public FormKey ExteriorCell { get; }

    // Three more SubCells cells, one per shape — each shares progressively more of
    // ExteriorCell's spatial ancestry, so copying it *after* ExteriorCell exercises "the
    // destination already overrides the WRLD (and maybe the block, and maybe the sub-block)".
    public const int OtherBlockX = 5;
    public const int OtherBlockY = 1;
    public const int OtherSubX = 21;
    public const int OtherSubY = 5;
    public const int OtherGridX = 170;
    public const int OtherGridY = 42;
    public const string OtherBlockCellEditorId = "SourceOtherBlockCell";
    public FormKey OtherBlockCell { get; }

    public const int SameBlockOtherSubX = 2;
    public const int SameBlockOtherSubY = -3;
    public const int SameBlockGridX = 17;
    public const int SameBlockGridY = -20;
    public const string SameBlockCellEditorId = "SourceSameBlockCell";
    public FormKey SameBlockCell { get; }

    public const string SameSubBlockCellEditorId = "SourceSameSubBlockCell";
    public FormKey SameSubBlockCell { get; }

    public const string ExteriorPersistentRefEditorId = "SourceExteriorPersistentRef";
    public FormKey ExteriorPersistentRef { get; }

    public const string ExteriorTemporaryRefEditorId = "SourceExteriorTemporaryRef";
    public FormKey ExteriorTemporaryRef { get; }

    private ContainerCopyFixture(bool destinationLoadsFirst, bool trackSource)
    {
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);

        var flatNpc = sourceMod.Npcs.AddNew(FlatNpcEditorId);

        var quest = new Quest(sourceMod) { EditorID = QuestEditorId };
        var dialogTopic = new DialogTopic(sourceMod) { EditorID = DialogTopicEditorId };
        var response1 = new DialogResponses(sourceMod) { EditorID = Response1EditorId };
        var response2 = new DialogResponses(sourceMod) { EditorID = Response2EditorId };
        response1.PreviousDialog.SetTo(response1);
        response2.PreviousDialog.SetTo(response1);
        dialogTopic.Responses.Add(response1);
        dialogTopic.Responses.Add(response2);
        quest.DialogTopics.Add(dialogTopic);
        var scene = new Scene(sourceMod) { EditorID = SceneEditorId };
        quest.Scenes.Add(scene);
        var dialogBranch = new DialogBranch(sourceMod) { EditorID = DialogBranchEditorId };
        quest.DialogBranches.Add(dialogBranch);
        sourceMod.Quests.Add(quest);

        var childlessQuest = new Quest(sourceMod) { EditorID = ChildlessQuestEditorId };
        sourceMod.Quests.Add(childlessQuest);
        var bareQuest = new Quest(sourceMod) { EditorID = BareQuestEditorId };
        var bareTopic = new DialogTopic(sourceMod) { EditorID = BareTopicEditorId };
        bareQuest.DialogTopics.Add(bareTopic);
        sourceMod.Quests.Add(bareQuest);
        (ChildlessQuest, BareQuest, BareTopic) = (childlessQuest.FormKey, bareQuest.FormKey, bareTopic.FormKey);

        var interiorCell = new Cell(sourceMod) { EditorID = InteriorCellEditorId, WaterHeight = InteriorCellWaterHeight };
        var persistentRef = new PlacedObject(sourceMod)
        {
            EditorID = PersistentRefEditorId,
            Position = new P3Float(1f, 2f, 3f),
            Scale = 1f,
        };
        var temporaryRef = new PlacedObject(sourceMod)
        {
            EditorID = TemporaryRefEditorId,
            Position = new P3Float(4f, 5f, 6f),
            Scale = 1f,
        };
        var navmesh = new NavigationMesh(sourceMod) { EditorID = NavmeshEditorId };
        var landscape = new Landscape(sourceMod) { EditorID = LandscapeEditorId };
        interiorCell.Persistent.Add(persistentRef);
        interiorCell.Temporary.Add(temporaryRef);
        interiorCell.NavigationMeshes.Add(navmesh);
        interiorCell.Landscape = landscape;
        AddInteriorCell(sourceMod, interiorCell, blockNumber: 0);

        var worldspace = new Worldspace(sourceMod) { EditorID = WorldspaceEditorId };
        var topCell = new Cell(sourceMod) { EditorID = TopCellEditorId };
        var topCellRef = new PlacedObject(sourceMod)
        {
            EditorID = TopCellRefEditorId,
            Position = new P3Float(7f, 8f, 9f),
            Scale = 1f,
        };
        topCell.Temporary.Add(topCellRef);
        worldspace.TopCell = topCell;

        var exteriorCell = new Cell(sourceMod)
        {
            EditorID = ExteriorCellEditorId,
            Grid = new CellGrid { Point = new P2Int(ExteriorGridX, ExteriorGridY) },
        };
        var exteriorPersistentRef = new PlacedObject(sourceMod)
        {
            EditorID = ExteriorPersistentRefEditorId,
            Position = new P3Float(10f, 11f, 12f),
            Scale = 1f,
        };
        var exteriorTemporaryRef = new PlacedObject(sourceMod)
        {
            EditorID = ExteriorTemporaryRefEditorId,
            Position = new P3Float(13f, 14f, 15f),
            Scale = 1f,
        };
        exteriorCell.Persistent.Add(exteriorPersistentRef);
        exteriorCell.Temporary.Add(exteriorTemporaryRef);
        var exteriorSubBlock = new WorldspaceSubBlock { BlockNumberX = (short)ExteriorSubX, BlockNumberY = (short)ExteriorSubY };
        exteriorSubBlock.Items.Add(exteriorCell);
        var exteriorBlock = new WorldspaceBlock { BlockNumberX = (short)ExteriorBlockX, BlockNumberY = (short)ExteriorBlockY };
        exteriorBlock.Items.Add(exteriorSubBlock);
        worldspace.SubCells.Add(exteriorBlock);

        var sameSubBlockCell = new Cell(sourceMod)
        {
            EditorID = SameSubBlockCellEditorId,
            Grid = new CellGrid { Point = new P2Int(ExteriorGridX + 1, ExteriorGridY + 1) },
        };
        exteriorSubBlock.Items.Add(sameSubBlockCell);

        var sameBlockCell = new Cell(sourceMod)
        {
            EditorID = SameBlockCellEditorId,
            Grid = new CellGrid { Point = new P2Int(SameBlockGridX, SameBlockGridY) },
        };
        var sameBlockOtherSub = new WorldspaceSubBlock { BlockNumberX = (short)SameBlockOtherSubX, BlockNumberY = (short)SameBlockOtherSubY };
        sameBlockOtherSub.Items.Add(sameBlockCell);
        exteriorBlock.Items.Add(sameBlockOtherSub);

        var otherBlockCell = new Cell(sourceMod)
        {
            EditorID = OtherBlockCellEditorId,
            Grid = new CellGrid { Point = new P2Int(OtherGridX, OtherGridY) },
        };
        var otherSub = new WorldspaceSubBlock { BlockNumberX = (short)OtherSubX, BlockNumberY = (short)OtherSubY };
        otherSub.Items.Add(otherBlockCell);
        var otherBlock = new WorldspaceBlock { BlockNumberX = (short)OtherBlockX, BlockNumberY = (short)OtherBlockY };
        otherBlock.Items.Add(otherSub);
        worldspace.SubCells.Add(otherBlock);

        sourceMod.Worldspaces.Add(worldspace);

        (Quest, DialogTopic) = (quest.FormKey, dialogTopic.FormKey);
        (Response1, Response2) = (response1.FormKey, response2.FormKey);
        (Scene, DialogBranch) = (scene.FormKey, dialogBranch.FormKey);
        FlatNpc = flatNpc.FormKey;
        InteriorCell = interiorCell.FormKey;
        (PersistentRef, TemporaryRef) = (persistentRef.FormKey, temporaryRef.FormKey);
        (Navmesh, Landscape) = (navmesh.FormKey, landscape.FormKey);
        (Worldspace, TopCell, TopCellRef) = (worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);
        ExteriorCell = exteriorCell.FormKey;
        (ExteriorPersistentRef, ExteriorTemporaryRef) = (exteriorPersistentRef.FormKey, exteriorTemporaryRef.FormKey);
        (OtherBlockCell, SameBlockCell, SameSubBlockCell) =
            (otherBlockCell.FormKey, sameBlockCell.FormKey, sameSubBlockCell.FormKey);

        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        var destinationNpc = destinationMod.Npcs.AddNew(DestinationNpcEditorId);
        DestinationNpc = destinationNpc.FormKey;

        if (destinationLoadsFirst)
        {
            DestinationPlugin = Add(destinationMod, DestinationOrigin);
            SourcePlugin = Add(sourceMod, SourceOrigin, trackSource);
        }
        else
        {
            SourcePlugin = Add(sourceMod, SourceOrigin, trackSource);
            DestinationPlugin = Add(destinationMod, DestinationOrigin);
        }
    }

    public static ContainerCopyFixture Create() => new(destinationLoadsFirst: false, trackSource: false);

    public static ContainerCopyFixture CreateWithTrackedSource() => new(destinationLoadsFirst: false, trackSource: true);

    public static ContainerCopyFixture CreateWithDestinationLoadingFirst() =>
        new(destinationLoadsFirst: true, trackSource: false);

    internal void AssertDestinationCellSitsAt(
        string cellFormKey, string? editorId, int blockX, int blockY, int subX, int subY)
    {
        var repository = TrackedTree.Repository(DestinationModFolder);
        var cell = new RecordIdentity(cellFormKey, "cell", editorId);

        Assert.Equal(Worldspace.ToString(), repository.WorldspaceOf(DestinationPlugin, cell));
        TreeTampering.AssertCellSitsInBlocks(DestinationModFolder, DestinationPlugin, cell, blockX, blockY, subX, subY);
    }

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell, int blockNumber)
    {
        var subBlock = new CellSubBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }
}
