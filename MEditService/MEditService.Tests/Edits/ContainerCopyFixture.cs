using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>Two mod folders, because one cannot ask whether a copy crosses plugins. The source
/// defaults untracked, so its records come through the Plugin adapter; no index anywhere in
/// it.</summary>
public sealed class ContainerCopyFixture : IDisposable
{
    public const string SourcePluginName = "ContainerSource.esm";
    public const string SourceOrigin = "ContainerSourceMod";
    public const string DestinationPluginName = "ContainerDestination.esp";
    public const string DestinationOrigin = "ContainerDestinationMod";

    public string SourceModFolder { get; }
    public string DestinationModFolder { get; }
    public string GameDirectory { get; }
    /// <summary>The same snapshot as a list, for a test that reconciles an index over these trees.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries { get; }

    public LoadOrder LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }
    public CopyRecordAsOverrideHandler CopyAsOverrideHandler { get; }
    public CopyRecordAsNewRecordHandler CopyAsNewHandler { get; }
    public PluginKey SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
    public PluginKey DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);

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

    // Two responses under the topic — "DIAL with INFOs": each copied child draws a fresh
    // FormKey, and Response2's sibling link at Response1 stays pointed at the *original* (never
    // remapped onto the copies — xEdit doesn't either).
    public const string Response1EditorId = "SourceResponse1";
    public FormKey Response1 { get; }

    public const string Response2EditorId = "SourceResponse2";
    public FormKey Response2 { get; }

    public const string SceneEditorId = "SourceScene";
    public FormKey Scene { get; }

    public const string DialogBranchEditorId = "SourceBranch";
    public FormKey DialogBranch { get; }

    // Interior — the non-spatial case: a real block/sub-block pair, but one whose
    // number carries no gameplay meaning (PlacementWalker.Walk's own interior branch, verified: block/
    // sub/grid are always null for an interior cell_location row).
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

    // TopCell is the simplest real exterior shape: PlacementWalker.WalkWorldspace emits it with no
    // block/sub/grid at all, so it proves the "exterior, ancestor missing" refusal without a genuine
    // SubCells grid position.
    public const string WorldspaceEditorId = "SourceWorld";
    public FormKey Worldspace { get; }

    public const string TopCellEditorId = "SourceTopCell";
    public FormKey TopCell { get; }

    public const string TopCellRefEditorId = "SourceTopCellRef";
    public FormKey TopCellRef { get; }

    // A real SubCells cell, distinct in every coordinate and not reproducible by a naive
    // floor(grid/N) formula, so an implementation that recomputed rather than copied
    // CellLocationRow's numbers cannot pass by coincidence.
    public const int ExteriorBlockX = 3;
    public const int ExteriorBlockY = -2;
    public const int ExteriorSubX = 0;
    public const int ExteriorSubY = -1;
    public const int ExteriorGridX = 200;
    public const int ExteriorGridY = -199;

    public const string ExteriorCellEditorId = "SourceExteriorCell";
    public FormKey ExteriorCell { get; }

    // Three more SubCells cells, one per shape — each shares progressively more of
    // ExteriorCell's spatial ancestry, so copying it *after* ExteriorCell exercises "the
    // destination already overrides the WRLD (and maybe the block, and maybe the sub-block)".
    public const int OtherBlockX = 5;
    public const int OtherBlockY = 1;
    public const int OtherSubX = 2;
    public const int OtherSubY = 3;
    public const string OtherBlockCellEditorId = "SourceOtherBlockCell";
    public FormKey OtherBlockCell { get; }

    public const int SameBlockOtherSubX = -4;
    public const int SameBlockOtherSubY = 6;
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
        SourceModFolder = Directory.CreateTempSubdirectory("medit-container-copy-source-").FullName;
        DestinationModFolder = Directory.CreateTempSubdirectory("medit-container-copy-dest-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-container-copy-game-").FullName;

        var sourcePath = Path.Combine(SourceModFolder, SourcePluginName);
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);

        var flatNpc = sourceMod.Npcs.AddNew(FlatNpcEditorId);

        var quest = new Quest(sourceMod) { EditorID = QuestEditorId };
        var dialogTopic = new DialogTopic(sourceMod) { EditorID = DialogTopicEditorId };
        var response1 = new DialogResponses(sourceMod) { EditorID = Response1EditorId };
        var response2 = new DialogResponses(sourceMod) { EditorID = Response2EditorId };
        response2.PreviousDialog.SetTo(response1);
        dialogTopic.Responses.Add(response1);
        dialogTopic.Responses.Add(response2);
        quest.DialogTopics.Add(dialogTopic);
        var scene = new Scene(sourceMod) { EditorID = SceneEditorId };
        quest.Scenes.Add(scene);
        var dialogBranch = new DialogBranch(sourceMod) { EditorID = DialogBranchEditorId };
        quest.DialogBranches.Add(dialogBranch);
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
            Grid = new CellGrid { Point = new P2Int(ExteriorGridX + 2, ExteriorGridY + 2) },
        };
        var sameBlockOtherSub = new WorldspaceSubBlock { BlockNumberX = (short)SameBlockOtherSubX, BlockNumberY = (short)SameBlockOtherSubY };
        sameBlockOtherSub.Items.Add(sameBlockCell);
        exteriorBlock.Items.Add(sameBlockOtherSub);

        var otherBlockCell = new Cell(sourceMod)
        {
            EditorID = OtherBlockCellEditorId,
            Grid = new CellGrid { Point = new P2Int(ExteriorGridX + 3, ExteriorGridY + 3) },
        };
        var otherSub = new WorldspaceSubBlock { BlockNumberX = (short)OtherSubX, BlockNumberY = (short)OtherSubY };
        otherSub.Items.Add(otherBlockCell);
        var otherBlock = new WorldspaceBlock { BlockNumberX = (short)OtherBlockX, BlockNumberY = (short)OtherBlockY };
        otherBlock.Items.Add(otherSub);
        worldspace.SubCells.Add(otherBlock);

        sourceMod.Worldspaces.Add(worldspace);

        sourceMod.WriteToBinary(sourcePath);
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

        var destinationPath = Path.Combine(DestinationModFolder, DestinationPluginName);
        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        var destinationNpc = destinationMod.Npcs.AddNew(DestinationNpcEditorId);
        destinationMod.WriteToBinary(destinationPath);
        DestinationNpc = destinationNpc.FormKey;

        Entries =
        [
            new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Slot: destinationLoadsFirst ? 1 : 0, Enabled: true, Winning: true),
            new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, Slot: destinationLoadsFirst ? 0 : 1, Enabled: true, Winning: true),
        ];
        LoadOrder = LoadOrder.From(GameDirectory, GameDirectory, GameRelease.Fallout4, Entries);

        Track(DestinationOrigin, DestinationPlugin);
        if (trackSource) Track(SourceOrigin, SourcePlugin);

        var holder = new LoadOrderHolder();
        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        CopyAsOverrideHandler = TestEditService.CopyAsOverrideHandler(holder);
        CopyAsNewHandler = TestEditService.CopyAsNewHandler(holder);
    }

    public static ContainerCopyFixture Create() => new(destinationLoadsFirst: false, trackSource: false);

    public static ContainerCopyFixture CreateWithTrackedSource() => new(destinationLoadsFirst: false, trackSource: true);

    public static ContainerCopyFixture CreateWithDestinationLoadingFirst() =>
        new(destinationLoadsFirst: true, trackSource: false);

    private void Track(string origin, PluginKey plugin) =>
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(LoadOrder, [plugin], origin, SourcePreset.Edits).GetAwaiter().GetResult();

    /// <summary>What a tracked plugin's tree holds for a FormKey — the whole read model here.</summary>
    public SourceDocument? Document(PluginKey plugin, string formKey) =>
        TrackedTree.Document(
            plugin.Origin == SourceOrigin ? SourceModFolder : DestinationModFolder, plugin, formKey);

    public IReadOnlyList<string> DestinationGitStatus() => TrackedTree.GitStatus(DestinationModFolder);

    /// <summary>Where the destination's tree puts a cell it holds — the block directories the mint
    /// wrote, read back the one way the write side reads them.</summary>
    internal CellPlacement? DestinationCellPlacement(string cellFormKey, string? editorId)
    {
        var repository = SourceRepository.Open(DestinationModFolder, GameRelease.Fallout4)!;
        return repository.CellPlacementOf(DestinationPlugin, new RecordIdentity(cellFormKey, "cell", editorId));
    }

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell, int blockNumber)
    {
        var subBlock = new CellSubBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    public string DestinationSourceRoot => Path.Combine(DestinationModFolder, SourceRepository.RootFor(DestinationPluginName));

    public string DestinationSourceFileContaining(string editorId) =>
        SourceFileContaining(DestinationPlugin, editorId);

    /// <summary>Any document in a tracked plugin's tree carrying an EditorID: a container's own
    /// RecordData.json, a flat record's file, or the file that inlines an embedded child.</summary>
    public string SourceFileContaining(PluginKey plugin, string editorId) =>
        Directory
            .EnumerateFiles(
                Path.Combine(
                    plugin.Origin == SourceOrigin ? SourceModFolder : DestinationModFolder,
                    SourceRepository.RootFor(plugin.Name)),
                "*.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    public void Dispose()
    {
        TryDelete(SourceModFolder);
        TryDelete(DestinationModFolder);
        TryDelete(GameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
