using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>The container counterpart to <see cref="SourceEditFixture"/>, which holds only flat
/// records and cannot exercise a container at all. No index anywhere in it (ADR-0014 invariant
/// 7).</summary>
public sealed class ContainerModFixture : IDisposable
{
    public const string ModFolderOrigin = "ContainerFixtureMod";
    public const string PluginName = "ContainerFixture.esp";

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public LoadOrderSnapshot LoadOrder { get; }
    public RenumberRecordHandler RenumberHandler { get; }
    public EditRecordHandler EditHandler { get; }
    public DeleteRecordHandler DeleteHandler { get; }

    /// <summary>The same snapshot as a list, for a test reconciling an index over this tree.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries { get; }
    public PluginKey Plugin { get; } = new(PluginName, ModFolderOrigin);

    public const string NpcEditorId = "FixtureNpc";
    public FormKey Npc { get; }

    public const string CellEditorId = "FixtureCell";
    public const float CellWaterHeight = 100f;
    public FormKey Cell { get; }

    public const string EmbedCellEditorId = "EmbedCell";
    public const float EmbedCellWaterHeight = 10f;
    public FormKey EmbedCell { get; }

    public const string TemporaryRefEditorId = "TempRef";
    public FormKey TemporaryRef { get; }

    public const string PersistentRefEditorId = "PersistRef";
    public FormKey PersistentRef { get; }

    public const string NavmeshEditorId = "EmbedNavmesh";
    public FormKey Navmesh { get; }

    public const string LandscapeEditorId = "EmbedLandscape";
    public FormKey Landscape { get; }

    public const string WorldspaceEditorId = "EmbedWorld";
    public FormKey Worldspace { get; }

    public const string TopCellEditorId = "EmbedTopCell";
    public const float TopCellWaterHeight = 5f;
    public FormKey TopCell { get; }

    public const string TopCellRefEditorId = "TopCellRef";
    public FormKey TopCellRef { get; }

    public const string QuestEditorId = "EmbedQuest";
    public FormKey Quest { get; }

    public const string DialogTopicEditorId = "EmbedTopic";
    public FormKey DialogTopic { get; }

    // Two responses inline in the first topic's document: a sibling is what shows an edit, a delete
    // or a renumber touching only its own element, and two is the shortest list with an order.
    public const string ResponseEditorId = "EmbedResponse";
    public FormKey Response { get; }

    public const string Response2EditorId = "EmbedResponse2";
    public FormKey Response2 { get; }

    // Two more siblings under the same Quest, so "delete/renumber a mid-list topic, then compile"
    // has an actual middle and two actual survivors to pin the GRUP order of — one DialogTopic
    // alone cannot exercise "gap, not renumbered".
    public const string DialogTopic2EditorId = "EmbedTopic2";
    public FormKey DialogTopic2 { get; }

    public const string DialogTopic3EditorId = "EmbedTopic3";
    public FormKey DialogTopic3 { get; }

    // The quest's other two child slots, one record each.
    public const string DialogBranchEditorId = "EmbedBranch";
    public FormKey DialogBranch { get; }

    public const string SceneEditorId = "EmbedScene";
    public FormKey Scene { get; }

    // The first response's own array field, seeded with two lines so an array op on an embedded
    // child has an order to change.
    public static readonly byte[] ResponseLineNumbers = [1, 2];

    public ContainerModFixture() : this(track: true) { }

    /// <summary>Deferred tracking, for the indexed wrapper: the Index reconciles over the untracked
    /// binary first, exactly as the process does before Track ever runs.</summary>
    internal ContainerModFixture(bool track)
    {
        var holder = new LoadOrderHolder();
        _instanceRoot = Directory.CreateTempSubdirectory("medit-container-mod-").FullName;
        ModFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", ModFolderOrigin)).FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;

        var pluginPath = Path.Combine(ModFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var npc = mod.Npcs.AddNew(NpcEditorId);

        var cell = new Cell(mod) { EditorID = CellEditorId, WaterHeight = CellWaterHeight };
        AddInteriorCell(mod, cell, blockNumber: 0);

        var embedCell = new Cell(mod) { EditorID = EmbedCellEditorId, WaterHeight = EmbedCellWaterHeight };
        var temporaryRef = new PlacedObject(mod)
        {
            EditorID = TemporaryRefEditorId,
            Position = new P3Float(11f, 22f, 33f),
            Scale = 1f,
        };
        var persistentRef = new PlacedObject(mod)
        {
            EditorID = PersistentRefEditorId,
            Position = new P3Float(1f, 2f, 3f),
            Scale = 4f,
        };
        var navmesh = new NavigationMesh(mod) { EditorID = NavmeshEditorId };
        var landscape = new Landscape(mod) { EditorID = LandscapeEditorId };
        embedCell.Temporary.Add(temporaryRef);
        embedCell.Persistent.Add(persistentRef);
        embedCell.NavigationMeshes.Add(navmesh);
        embedCell.Landscape = landscape;
        AddInteriorCell(mod, embedCell, blockNumber: 1);

        var worldspace = new Worldspace(mod) { EditorID = WorldspaceEditorId };
        var topCell = new Cell(mod) { EditorID = TopCellEditorId, WaterHeight = TopCellWaterHeight };
        var topCellRef = new PlacedObject(mod)
        {
            EditorID = TopCellRefEditorId,
            Position = new P3Float(7f, 8f, 9f),
            Scale = 6f,
        };
        topCell.Temporary.Add(topCellRef);
        worldspace.TopCell = topCell;
        mod.Worldspaces.Add(worldspace);

        var quest = new Quest(mod) { EditorID = QuestEditorId };
        var dialogTopic = new DialogTopic(mod) { EditorID = DialogTopicEditorId };
        var response = new DialogResponses(mod) { EditorID = ResponseEditorId };
        foreach (var line in ResponseLineNumbers) response.Responses.Add(new DialogResponse { ResponseNumber = line });
        var response2 = new DialogResponses(mod) { EditorID = Response2EditorId };
        dialogTopic.Responses.Add(response);
        dialogTopic.Responses.Add(response2);
        var dialogTopic2 = new DialogTopic(mod) { EditorID = DialogTopic2EditorId };
        var dialogTopic3 = new DialogTopic(mod) { EditorID = DialogTopic3EditorId };
        quest.DialogTopics.Add(dialogTopic);
        quest.DialogTopics.Add(dialogTopic2);
        quest.DialogTopics.Add(dialogTopic3);
        var dialogBranch = new DialogBranch(mod) { EditorID = DialogBranchEditorId };
        quest.DialogBranches.Add(dialogBranch);
        var scene = new Scene(mod) { EditorID = SceneEditorId };
        quest.Scenes.Add(scene);
        mod.Quests.Add(quest);

        mod.WriteToBinary(pluginPath);

        Npc = npc.FormKey;
        Cell = cell.FormKey;
        (EmbedCell, TemporaryRef, PersistentRef) = (embedCell.FormKey, temporaryRef.FormKey, persistentRef.FormKey);
        (Navmesh, Landscape) = (navmesh.FormKey, landscape.FormKey);
        (Worldspace, TopCell, TopCellRef) = (worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);
        (Quest, DialogTopic) = (quest.FormKey, dialogTopic.FormKey);
        (Response, Response2) = (response.FormKey, response2.FormKey);
        (DialogTopic2, DialogTopic3) = (dialogTopic2.FormKey, dialogTopic3.FormKey);
        (DialogBranch, Scene) = (dialogBranch.FormKey, scene.FormKey);

        Entries = [new LoadOrderEntry(PluginName, pluginPath, ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)];
        LoadOrder = new LoadOrderSnapshot(GameDirectory, _instanceRoot, GameRelease.Fallout4, SnapshotCopies.Of(Entries));

        if (track) Track();

        holder.Apply(LoadOrder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
    }

    private readonly string _instanceRoot;

    /// <summary>Track through the real service: what an edit does to a git working tree is the thing
    /// under test, and no mock can answer that.</summary>
    internal void Track() =>
        new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(LoadOrder, [Plugin], ModFolderOrigin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

    /// <summary>What the tree holds for a FormKey, read back through the same repository the write
    /// side wrote through — an embedded child cut back out of its owner's document included.</summary>
    public SourceDocument? Document(string formKey) => TrackedTree.Document(ModFolder, Plugin, formKey);

    /// <summary>The same question at HEAD: what the last commit holds, which a working-tree change
    /// does not alter.</summary>
    public SourceDocument? CommittedDocument(string formKey, string recordType, string? editorId) =>
        TrackedTree.CommittedDocument(ModFolder, Plugin, new RecordIdentity(formKey, recordType, editorId));

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell, int blockNumber)
    {
        var subBlock = new CellSubBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    public string SourceRoot => Path.Combine(ModFolder, SourceRepository.RootFor(PluginName));

    /// <summary>The mod-level Absorb/Keep gestures take a plugin list, not one plugin — this
    /// fixture's own single plugin, wrapped.</summary>
    public static IReadOnlyList<RegisteredCopy> PluginCopies(string pluginPath) =>
        [new RegisteredCopy(PluginName, ModFolderOrigin, pluginPath, 0, true, true)];

    // Any document: a container's RecordData.json, a flat record's own file, or the file that inlines
    // an embedded child.
    public string SourceFileContaining(string editorId) =>
        Directory.EnumerateFiles(SourceRoot, "*.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    public IReadOnlyList<string> GitStatus() =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => UnquotePorcelainLine(l.Trim()))
            .ToList();

    // Unavoidable, not defensive: plain porcelain v1 C-quotes any path containing a space
    // unconditionally — core.quotePath governs only bytes above 0x80 — and these names all have one.
    private static string UnquotePorcelainLine(string line)
    {
        var space = line.IndexOf(' ');
        if (space < 0) return line;
        var status = line[..space];
        var rest = line[(space + 1)..].TrimStart();
        if (rest.Length < 2 || rest[0] != '"' || rest[^1] != '"') return line;

        var inner = rest[1..^1];
        var unquoted = new System.Text.StringBuilder(inner.Length);
        for (var i = 0; i < inner.Length; i++)
        {
            if (inner[i] != '\\' || i + 1 >= inner.Length) { unquoted.Append(inner[i]); continue; }
            var next = inner[++i];
            unquoted.Append(next switch
            {
                '"' => '"',
                '\\' => '\\',
                't' => '\t',
                'n' => '\n',
                _ => next,
            });
        }
        return $"{status} {unquoted}";
    }

    // A tracked mod folder holds a .git tree whose object files are read-only on some filesystems,
    // and a test failing on cleanup would mask the real assertion that already ran.
    public void Dispose()
    {
        try { Directory.Delete(_instanceRoot, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
