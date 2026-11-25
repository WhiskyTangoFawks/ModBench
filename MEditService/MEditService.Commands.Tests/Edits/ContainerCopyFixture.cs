using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two mod folders, because one cannot ask whether a copy crosses plugins. The source
/// defaults to a plugin with no plugin source, so its records come through the Plugin adapter; no index anywhere in
/// it.</summary>
public sealed class ContainerCopyFixture : TestInstance, ICompiledPlugins
{
    public const string SourcePluginName = "ContainerSource.esm";
    public const string SourceOrigin = "ContainerSourceMod";
    public const string DestinationPluginName = "ContainerDestination.esp";
    public const string DestinationOrigin = "ContainerDestinationMod";

    public string SourceModFolder => FolderOf(SourceOrigin);
    public string DestinationModFolder => FolderOf(DestinationOrigin);
    public PluginAddress SourcePlugin { get; }
    public PluginAddress DestinationPlugin { get; }

    public const string QuestEditorId = "SourceQuest";
    public FormKey Quest { get; }

    public FormKey FlatNpc { get; }

    public const string DialogTopicEditorId = "SourceTopic";
    public FormKey DialogTopic { get; }

    // Two responses under the topic: DIAL with INFOs. Response1 links to itself, Response2 to Response1.
    public FormKey Response1 { get; }

    public FormKey Response2 { get; }

    public const string SceneEditorId = "SourceScene";
    public FormKey Scene { get; }

    // Interior — the non-spatial case: a real block/sub-block pair.
    public const string InteriorCellEditorId = "SourceInteriorCell";
    public const float InteriorCellWaterHeight = 100f;
    public FormKey InteriorCell { get; }

    public const string PersistentRefEditorId = "SourcePersistentRef";
    public FormKey PersistentRef { get; }

    public const string TemporaryRefEditorId = "SourceTemporaryRef";
    public FormKey TemporaryRef { get; }

    // TopCell is a worldspace's persistent cell: embedded in the worldspace's document, with no grid.
    public const string WorldspaceEditorId = "SourceWorld";
    public FormKey Worldspace { get; }

    public FormKey TopCell { get; }

    // A real SubCells cell: each cell's block and sub-block are the ones its own grid falls in.
    public const int ExteriorBlockX = 0;
    public const int ExteriorBlockY = -1;
    public const int ExteriorSubX = 0;
    public const int ExteriorSubY = -1;
    public const int ExteriorGridX = 1;
    public const int ExteriorGridY = -2;

    public const string ExteriorCellEditorId = "SourceExteriorCell";
    public FormKey ExteriorCell { get; }

    public const string ExteriorPersistentRefEditorId = "SourceExteriorPersistentRef";
    public FormKey ExteriorPersistentRef { get; }

    public const string ExteriorTemporaryRefEditorId = "SourceExteriorTemporaryRef";
    public FormKey ExteriorTemporaryRef { get; }

    private ContainerCopyFixture(bool initSource)
    {
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);

        var flatNpc = sourceMod.Npcs.AddNew("SourceFlatNpc");

        var quest = new Quest(sourceMod) { EditorID = QuestEditorId };
        var dialogTopic = new DialogTopic(sourceMod) { EditorID = DialogTopicEditorId };
        var response1 = new DialogResponses(sourceMod) { EditorID = "SourceResponse1" };
        var response2 = new DialogResponses(sourceMod) { EditorID = "SourceResponse2" };
        response1.PreviousDialog.SetTo(response1);
        response2.PreviousDialog.SetTo(response1);
        dialogTopic.Responses.Add(response1);
        dialogTopic.Responses.Add(response2);
        quest.DialogTopics.Add(dialogTopic);
        var scene = new Scene(sourceMod) { EditorID = SceneEditorId };
        quest.Scenes.Add(scene);
        sourceMod.Quests.Add(quest);

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
        interiorCell.Persistent.Add(persistentRef);
        interiorCell.Temporary.Add(temporaryRef);
        sourceMod.AddInteriorCells(interiorCell);

        var worldspace = new Worldspace(sourceMod) { EditorID = WorldspaceEditorId };
        var topCell = new Cell(sourceMod) { EditorID = "SourceTopCell" };
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

        sourceMod.Worldspaces.Add(worldspace);

        (Quest, DialogTopic) = (quest.FormKey, dialogTopic.FormKey);
        (Response1, Response2) = (response1.FormKey, response2.FormKey);
        Scene = scene.FormKey;
        FlatNpc = flatNpc.FormKey;
        InteriorCell = interiorCell.FormKey;
        (PersistentRef, TemporaryRef) = (persistentRef.FormKey, temporaryRef.FormKey);
        (Worldspace, TopCell) = (worldspace.FormKey, topCell.FormKey);
        ExteriorCell = exteriorCell.FormKey;
        (ExteriorPersistentRef, ExteriorTemporaryRef) = (exteriorPersistentRef.FormKey, exteriorTemporaryRef.FormKey);

        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        destinationMod.Npcs.AddNew("DestinationNpc");

        SourcePlugin = Add(sourceMod, SourceOrigin, initSource);
        DestinationPlugin = Add(destinationMod, DestinationOrigin);
    }

    public static ContainerCopyFixture Create() => new(initSource: false);

    public static ContainerCopyFixture CreateWithCompiledPluginSource() => new(initSource: true);

    internal void AssertDestinationCellSitsAt(
        string cellFormKey, string? editorId, int blockX, int blockY, int subX, int subY)
    {
        var repository = SourceModTree.Repository(DestinationModFolder, DestinationPlugin);
        var cell = new RecordIdentity(cellFormKey, "cell", editorId);

        Assert.Equal(Worldspace.ToString(), repository.WorldspaceOf(DestinationPlugin, cell).Value());
        TreeTampering.AssertCellSitsInBlocks(DestinationModFolder, DestinationPlugin, cell, blockX, blockY, subX, subY);
    }
}
