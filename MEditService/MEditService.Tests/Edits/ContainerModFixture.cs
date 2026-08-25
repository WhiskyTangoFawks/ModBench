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
/// #466: the container-record counterpart to <see cref="TrackedModFixture"/> — same posture (a real
/// mod folder, a real plugin, a real git tree, tracked through the real <see cref="TrackService"/>),
/// different record content. <see cref="TrackedModFixture"/> holds only Npc/Race/Keyword and
/// structurally cannot exercise a container at all, which is exactly how #451 shipped a container
/// regression no test could see (three ad-hoc local fixtures grew up around that gap instead — see
/// git history on <c>ContainerRecordRegressionTests</c>, <c>SourceIngestContainerTests</c> and
/// <c>EmbeddedChildEditTests</c>). This fixture consolidates those three into one shared instance,
/// carrying the union of shapes they each needed:
///
/// <list type="bullet">
/// <item><description><see cref="Cell"/> — a standalone Cell with no embedded children, so a
/// point-write's byte-substitution assertions never share text with a child's.</description></item>
/// <item><description><see cref="EmbedCell"/> — a Cell carrying all four of Cell's embeddable slots
/// at once (two placed refs, a navmesh, a landscape), so a resolver that handles one slot and quietly
/// fails on another cannot pass.</description></item>
/// <item><description><see cref="Worldspace"/>/<see cref="TopCell"/>/<see cref="TopCellRef"/> — a
/// Worldspace whose TopCell embeds a further placed ref two embed-levels deep in one
/// file.</description></item>
/// <item><description><see cref="Quest"/>/<see cref="DialogTopic"/> — a folder-split child (its own
/// directory, not embedded), so a search that descends into every child slot would lose an edit into
/// the wrong file.</description></item>
/// <item><description><see cref="Npc"/> — a plain, unreferenced flat record, for "the container guard
/// doesn't blanket-refuse the rest of the plugin" and "a flat record beside a container still
/// reconciles" controls.</description></item>
/// </list>
///
/// <see cref="Core.Schema.SchemaReflector"/> publishes no schema at all for <c>land</c>/<c>navm</c>
/// (they are not record types mEdit surfaces), so <see cref="Navmesh"/> and <see cref="Landscape"/>
/// have no field a test can write through <c>EditField</c> regardless of fixture — they exist here so
/// a test can still assert their parentage survives a sibling edit intact.
/// </summary>
public sealed class ContainerModFixture : IDisposable
{
    public const string ModFolderOrigin = "ContainerFixtureMod";
    public const string PluginName = "ContainerFixture.esp";

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public SessionManager Sessions { get; }
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

    // #461 AC5: two more siblings under the same Quest, so "delete/renumber a mid-list folder-split
    // child, then compile" has an actual middle and two actual survivors to pin the GRUP order of —
    // one DialogTopic alone (the #453/#460-era shape above) cannot exercise "gap, not renumbered".
    public const string DialogTopic2EditorId = "EmbedTopic2";
    public FormKey DialogTopic2 { get; }

    public const string DialogTopic3EditorId = "EmbedTopic3";
    public FormKey DialogTopic3 { get; }

    public ContainerModFixture()
    {
        ModFolder = Directory.CreateTempSubdirectory("medit-container-mod-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-container-game-").FullName;

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
        var dialogTopic2 = new DialogTopic(mod) { EditorID = DialogTopic2EditorId };
        var dialogTopic3 = new DialogTopic(mod) { EditorID = DialogTopic3EditorId };
        quest.DialogTopics.Add(dialogTopic);
        quest.DialogTopics.Add(dialogTopic2);
        quest.DialogTopics.Add(dialogTopic3);
        mod.Quests.Add(quest);

        mod.WriteToBinary(pluginPath);

        Npc = npc.FormKey;
        Cell = cell.FormKey;
        (EmbedCell, TemporaryRef, PersistentRef) = (embedCell.FormKey, temporaryRef.FormKey, persistentRef.FormKey);
        (Navmesh, Landscape) = (navmesh.FormKey, landscape.FormKey);
        (Worldspace, TopCell, TopCellRef) = (worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);
        (Quest, DialogTopic) = (quest.FormKey, dialogTopic.FormKey);
        (DialogTopic2, DialogTopic3) = (dialogTopic2.FormKey, dialogTopic3.FormKey);

        Sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)Sessions).LoadExplicit(
            GameDirectory,
            [new ExplicitPluginInput(PluginName, pluginPath, ModFolderOrigin, true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(Sessions.Session!, ModFolderOrigin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell, int blockNumber)
    {
        var subBlock = new CellSubBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    /// <summary>The tree Track wrote everything above into.</summary>
    public string SourceRoot => Path.Combine(ModFolder, $"{PluginName}{SourceRecordPath.SourceSuffix}");

    /// <summary>The source file whose text contains <paramref name="editorId"/> — found by content
    /// rather than by <see cref="SourceRecordPath.For"/>, which has no flat path for a container and
    /// throws by design. The same locator all three predecessor fixtures hand-rolled.</summary>
    public string SourceFileContaining(string editorId) =>
        Directory.EnumerateFiles(SourceRoot, "RecordData.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    /// <summary>Porcelain status, scoped to the mod folder — what the native Source Control panel
    /// renders, asked the way a user would ask it.
    ///
    /// <para>Unquoted, for the same reason as <see cref="TrackedModFixture"/>'s own <c>GitStatus</c>:
    /// a container's directory name carries the identical <c>"&lt;EditorID&gt; - &lt;hex6&gt;_&lt;
    /// ModKeyFileName&gt;"</c> shape as this fixture's flat file names, spaces included, and plain
    /// (non-<c>-z</c>) porcelain v1 always C-quotes a path containing one — unconditionally, not gated
    /// by <c>core.quotePath</c>. Every caller here that ever compares against a plain expected string
    /// needs the unquoted text, the same way <see cref="TrackedModFixture"/>'s callers do.</para>
    /// </summary>
    public IReadOnlyList<string> GitStatus() =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => UnquotePorcelainLine(l.Trim()))
            .ToList();

    // "XY <path>" — <path> is C-quoted (wrapped in "...", \\ and \" escaped, higher bytes as \NNN
    // octal when core.quotePath's default applies) exactly when it needs to be; this repo's own Track
    // sets core.quotePath=false, so the only escapes a filename built from this fixture's own naming
    // scheme can ever produce are \\ and \" — but is written generally rather than special-cased to
    // that. Duplicated from TrackedModFixture rather than shared, to keep that fixture (and the 24
    // files depending on it) untouched by #466.
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

    public void Dispose()
    {
        Sessions.Dispose();
        TryDelete(ModFolder);
        TryDelete(GameDirectory);
    }

    // A tracked mod folder holds a .git tree whose object files are read-only on some filesystems,
    // and a test failing on cleanup would mask the real assertion that already ran.
    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
