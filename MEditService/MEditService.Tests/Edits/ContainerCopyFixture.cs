using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// #440: the container-copy counterpart to <see cref="CopyFixture"/> — two real mod folders (a
/// container-rich, untracked source; a minimal, tracked destination), the shape every Arc A copy
/// scenario needs (does a copy read a container from one plugin's tree/index and write it into a
/// different one's). <see cref="ContainerModFixture"/> is the nearest sibling but holds only one
/// plugin, which cannot ask the copy-across-plugins question at all.
///
/// <para>Source stays untracked by default (<see cref="CopyFixture"/>'s own primary-scenario
/// posture — copying out of a Data-directory master, the indexed body is the only representation
/// that exists for it); every read this fixture's own test suites need (placement, cell_location,
/// container_child) comes from the index, not the tree, so an untracked source answers them exactly
/// as a tracked one would.</para>
/// </summary>
public sealed class ContainerCopyFixture : IDisposable
{
    public const string SourcePluginName = "ContainerSource.esm";
    public const string SourceOrigin = "ContainerSourceMod";
    public const string DestinationPluginName = "ContainerDestination.esp";
    public const string DestinationOrigin = "ContainerDestinationMod";

    public string SourceModFolder { get; }
    public string DestinationModFolder { get; }
    public string GameDirectory { get; }
    public SessionManager Sessions { get; }
    public PluginKey SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
    public PluginKey DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);

    public const string DestinationNpcEditorId = "DestinationNpc";
    public FormKey DestinationNpc { get; }

    public const string QuestEditorId = "SourceQuest";
    public FormKey Quest { get; }

    public const string DialogTopicEditorId = "SourceTopic";
    public FormKey DialogTopic { get; }

    // Interior — the non-spatial case (#440 slices 6/7): a real block/sub-block pair, but one whose
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

    // Exterior — the spatial case Arc A deliberately keeps refusing (slice 6's negative boundary,
    // #549's own scope to widen). TopCell is the simplest real exterior shape: PlacementWalker.
    // WalkWorldspace emits it with isInterior:false and no block/sub/grid at all, so it proves the
    // "exterior, ancestor missing" refusal without needing a genuine SubCells grid position.
    public const string WorldspaceEditorId = "SourceWorld";
    public FormKey Worldspace { get; }

    public const string TopCellEditorId = "SourceTopCell";
    public FormKey TopCell { get; }

    public const string TopCellRefEditorId = "SourceTopCellRef";
    public FormKey TopCellRef { get; }

    // #549 Arc B (AC1): the genuine spatial-exterior shape TopCell above deliberately isn't — a real
    // SubCells cell with its own block/sub-block/grid position, distinct in every coordinate (and not
    // reproducible by a naive floor(grid/N)-style formula) so a wrong implementation that recomputed
    // rather than copied CellLocationRow's own numbers cannot pass by coincidence.
    public const int ExteriorBlockX = 3;
    public const int ExteriorBlockY = -2;
    public const int ExteriorSubX = 0;
    public const int ExteriorSubY = -1;
    public const int ExteriorGridX = 200;
    public const int ExteriorGridY = -199;

    public const string ExteriorCellEditorId = "SourceExteriorCell";
    public FormKey ExteriorCell { get; }

    public const string ExteriorPersistentRefEditorId = "SourceExteriorPersistentRef";
    public FormKey ExteriorPersistentRef { get; }

    public const string ExteriorTemporaryRefEditorId = "SourceExteriorTemporaryRef";
    public FormKey ExteriorTemporaryRef { get; }

    private ContainerCopyFixture()
    {
        SourceModFolder = Directory.CreateTempSubdirectory("medit-container-copy-source-").FullName;
        DestinationModFolder = Directory.CreateTempSubdirectory("medit-container-copy-dest-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-container-copy-game-").FullName;

        var sourcePath = Path.Combine(SourceModFolder, SourcePluginName);
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);

        var quest = new Quest(sourceMod) { EditorID = QuestEditorId };
        var dialogTopic = new DialogTopic(sourceMod) { EditorID = DialogTopicEditorId };
        quest.DialogTopics.Add(dialogTopic);
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

        sourceMod.Worldspaces.Add(worldspace);

        sourceMod.WriteToBinary(sourcePath);
        (Quest, DialogTopic) = (quest.FormKey, dialogTopic.FormKey);
        InteriorCell = interiorCell.FormKey;
        (PersistentRef, TemporaryRef) = (persistentRef.FormKey, temporaryRef.FormKey);
        (Navmesh, Landscape) = (navmesh.FormKey, landscape.FormKey);
        (Worldspace, TopCell, TopCellRef) = (worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);
        ExteriorCell = exteriorCell.FormKey;
        (ExteriorPersistentRef, ExteriorTemporaryRef) = (exteriorPersistentRef.FormKey, exteriorTemporaryRef.FormKey);

        var destinationPath = Path.Combine(DestinationModFolder, DestinationPluginName);
        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        var destinationNpc = destinationMod.Npcs.AddNew(DestinationNpcEditorId);
        destinationMod.WriteToBinary(destinationPath);
        DestinationNpc = destinationNpc.FormKey;

        Sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)Sessions).LoadExplicit(
            GameDirectory,
            [
                new ExplicitPluginInput(SourcePluginName, sourcePath, SourceOrigin, true),
                new ExplicitPluginInput(DestinationPluginName, destinationPath, DestinationOrigin, true),
            ],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(Sessions.Session!, DestinationOrigin, SourcePreset.Edits).GetAwaiter().GetResult();
    }

    public static ContainerCopyFixture Create() => new();

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell, int blockNumber)
    {
        var subBlock = new CellSubBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    /// <summary>The tree Track wrote the destination plugin into.</summary>
    public string DestinationSourceRoot => Path.Combine(DestinationModFolder, SourceRecordPath.RootFor(DestinationPluginName));

    /// <summary>The destination source file whose text contains <paramref name="editorId"/> — found
    /// by content, the same way <see cref="ContainerModFixture.SourceFileContaining"/> does, since a
    /// container has no flat <see cref="SourceRecordPath.For"/> path to compute.</summary>
    public string DestinationSourceFileContaining(string editorId) =>
        Directory.EnumerateFiles(DestinationSourceRoot, "RecordData.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    public void Dispose()
    {
        Sessions.Dispose();
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
