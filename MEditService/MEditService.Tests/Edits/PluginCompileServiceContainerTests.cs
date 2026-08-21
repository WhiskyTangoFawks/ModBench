using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// #454 AC2: the three container shapes the #444 spike probed become <b>compile-path</b> tests.
///
/// <para>The spike (<c>docs/research/spike-444-folder-split-containers.md</c>) proved that the two
/// #387 container defects — child folders keyed by field name alone, so two cells sharing a directory
/// merge their children; and <c>Worldspace_Serialization</c> never touching <c>SubCells</c>, dropping
/// the whole exterior hierarchy — are artifacts of driving the generated serializers <i>per record</i>,
/// and that the whole-mod folder-split path has neither. It proved that for a serialize/deserialize
/// round trip. This suite proves it for the thing that actually ships: Track the shape, compile it back
/// to a binary, and re-import that binary.</para>
///
/// <para><b>Why a local fixture and not <see cref="TrackedModFixture"/>.</b> That one holds
/// Npc/Race/Keyword and no containers at all, so it structurally cannot exercise any of this — the
/// same reason <see cref="Source.ContainerRecordRegressionTests"/> and
/// <see cref="Source.SourceIngestContainerTests"/> each carry their own. The real #369 fixture covers
/// the same ground at scale in <c>RealData/CompileRoundTripGateTests</c>; this is the fast, readable
/// statement of each specific property, with the two-of-a-kind arrangement (two cells in one
/// sub-block, two quests) that a curated real fixture does not guarantee.</para>
///
/// <para><b>Nothing here asserts child <i>ordering</i>.</b> Spriggit's layout carries none — its
/// reader sorts on a <c>"[N] "</c> file-name prefix written only under
/// <c>Overall.EnforceRecordOrder</c>, which neither this project nor Spriggit enables — so what these
/// assert is the child <i>set</i>, per #454's own scope item 4. Ordering for FO4
/// <c>DialogTopic.Responses</c> is tracked separately as #459.</para>
/// </summary>
public sealed class PluginCompileServiceContainerTests : IDisposable
{
    private const string PluginName = "ContainerCompile.esp";
    private const string Origin = "ContainerCompileMod";

    // Header fields with values nothing derives — a compile that emitted a fresh header instead of the
    // tree's own root RecordData.json would leave both null.
    private const string HeaderAuthor = "CompileHeaderAuthor";
    private const string HeaderDescription = "Header carried from the source tree.";

    private readonly string _modFolder;
    private readonly string _gameDirectory;
    private readonly SessionManager _sessions;
    private readonly PluginKey _plugin = new(PluginName, Origin);

    private readonly FormKey _cellA;
    private readonly FormKey _cellB;
    private readonly FormKey _cellATemporaryRef;
    private readonly FormKey _worldspace;
    private readonly FormKey _topCell;
    private readonly FormKey _exteriorCell;
    private readonly FormKey _questA;
    private readonly FormKey _questB;

    public PluginCompileServiceContainerTests()
    {
        _modFolder = Directory.CreateTempSubdirectory("medit-container-compile-").FullName;
        _gameDirectory = Directory.CreateTempSubdirectory("medit-container-compile-game-").FullName;

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.ModHeader.Author = HeaderAuthor;
        mod.ModHeader.Description = HeaderDescription;

        // ── #387 defect 1: two cells in ONE sub-block, each with its own children. Under the
        //    per-record path both cells' children landed in one field-name-keyed directory and each
        //    cell read back the union. Two is the minimum that can show it.
        var cellA = new Cell(mod) { EditorID = "CellA", WaterHeight = 1f };
        cellA.Persistent.Add(new PlacedObject(mod) { EditorID = "A_Persist", Position = new P3Float(1f, 1f, 1f) });
        var cellATemporaryRef = new PlacedObject(mod) { EditorID = "A_Temp", Position = new P3Float(2f, 2f, 2f) };
        // A deliberately dangling Base, inside this plugin's own FormID space so it needs no master:
        // semantic breakage that compiles with a diagnostic rather than refusing (#416 S5), carried by a
        // record that has no source file of its own. That is the diagnostic-path case below.
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

        // ── #387 defect 2: the worldspace's whole exterior XY hierarchy, plus its TopCell.
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

        // ── The spike's third probe: two quests, each with its own dialogue, all folder-split.
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

        mod.WriteToBinary(pluginPath);
        (_cellA, _cellB, _cellATemporaryRef) = (cellA.FormKey, cellB.FormKey, cellATemporaryRef.FormKey);
        (_worldspace, _topCell, _exteriorCell) = (worldspace.FormKey, topCell.FormKey, exteriorCell.FormKey);
        (_questA, _questB) = (questA.FormKey, questB.FormKey);

        _sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)_sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(PluginName, pluginPath, Origin, true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_sessions.Session!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _sessions.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private PluginCompileService CompileService() =>
        new(_sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    /// <summary>Compiles, asserts success, and hands back the binary that landed — every test here is
    /// "compile, then read what was written", never "compile and trust the result object".</summary>
    private IFallout4ModGetter CompileAndReimport(out IDisposable handle)
    {
        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        handle = overlay;
        return (IFallout4ModGetter)overlay;
    }

    private static IEnumerable<ICellGetter> AllCells(IFallout4ModGetter mod) =>
        mod.EnumerateMajorRecords<ICellGetter>();

    [Fact]
    public void Compile_OfTwoCellsInOneSubBlock_GivesEachCellExactlyItsOwnChildren()
    {
        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            var a = AllCells(mod).Single(c => c.FormKey == _cellA);
            var b = AllCells(mod).Single(c => c.FormKey == _cellB);

            Assert.Equal(["A_Persist"], a.Persistent.Select(r => r.EditorID!).Order().ToArray());
            Assert.Equal(["A_Temp"], a.Temporary.Select(r => r.EditorID!).Order().ToArray());
            Assert.Equal(["B_Persist"], b.Persistent.Select(r => r.EditorID!).Order().ToArray());
            Assert.Equal(["B_Temp"], b.Temporary.Select(r => r.EditorID!).Order().ToArray());
        }
    }

    [Fact]
    public void Compile_OfAWorldspace_KeepsTheExteriorHierarchyAndTheTopCell()
    {
        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            var worldspace = mod.Worldspaces.Single(w => w.FormKey == _worldspace);

            Assert.NotNull(worldspace.TopCell);
            Assert.Equal(_topCell, worldspace.TopCell!.FormKey);
            Assert.Equal(["Top_Temp"], worldspace.TopCell.Temporary.Select(r => r.EditorID!).ToArray());

            var writtenBlock = Assert.Single(worldspace.SubCells);
            Assert.Equal(0, writtenBlock.BlockNumberX);
            Assert.Equal(-1, writtenBlock.BlockNumberY);
            var writtenSubBlock = Assert.Single(writtenBlock.Items);
            Assert.Equal(3, writtenSubBlock.BlockNumberX);
            Assert.Equal(-4, writtenSubBlock.BlockNumberY);

            var cell = Assert.Single(writtenSubBlock.Items);
            Assert.Equal(_exteriorCell, cell.FormKey);
            Assert.Equal(new P2Int(3, -4), cell.Grid!.Point);
            Assert.Equal(["Ext_Temp"], cell.Temporary.Select(r => r.EditorID!).ToArray());
        }
    }

    [Fact]
    public void Compile_OfTwoQuests_GivesEachQuestExactlyItsOwnDialogueAndScenes()
    {
        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            var a = mod.Quests.Single(q => q.FormKey == _questA);
            var b = mod.Quests.Single(q => q.FormKey == _questB);

            Assert.Equal(["TopicA"], a.DialogTopics.Select(t => t.EditorID!).Order().ToArray());
            Assert.Equal(["TopicB"], b.DialogTopics.Select(t => t.EditorID!).Order().ToArray());
            Assert.Equal(["SceneA"], a.Scenes.Select(s => s.EditorID!).Order().ToArray());
            Assert.Empty(b.Scenes);

            Assert.Equal(
                ["ResponseA"],
                a.DialogTopics.Single().Responses.Select(r => r.EditorID!).Order().ToArray());
            Assert.Equal(
                ["ResponseB"],
                b.DialogTopics.Single().Responses.Select(r => r.EditorID!).Order().ToArray());
        }
    }

    /// <summary>
    /// A diagnostic names the source unit the record actually lives in — #454's replacement for the
    /// per-file <c>pathsByFormKey</c> map the old per-record read built as a side effect.
    ///
    /// <para>Compile no longer reads files one at a time, so there is no such map; the answer comes from
    /// <c>SourceUnitResolver</c> (#453) instead, which is the one place in this codebase that knows where
    /// a record's bytes are. That is what keeps the Problems-panel URI the extension builds
    /// (<c>publishCompileDiagnostics</c>) pointing at a file that exists.</para>
    ///
    /// <para>An <b>embedded</b> child is the sharpest case and is deliberately the one asserted: a placed
    /// reference has no file of its own — its bytes are inline in its cell's document — so the old map
    /// had no entry for it at all and it could not be reported. Its diagnostic now names the cell's own
    /// <c>RecordData.json</c>, which is where a user opening it would in fact find the record.</para>
    /// </summary>
    [Fact]
    public void Compile_ForAnEmbeddedChildWithASemanticError_NamesTheContainersOwnSourceFile()
    {
        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var diagnostic = Assert.Single(
            result.Diagnostics.Where(d => d.FormKey == _cellATemporaryRef.ToString()).Take(1));

        var full = Path.Combine(_modFolder, diagnostic.SourceRelativePath);
        Assert.True(File.Exists(full), $"'{diagnostic.SourceRelativePath}' is not a file in the tree.");
        Assert.Equal("RecordData.json", Path.GetFileName(full));
        Assert.Contains("\"CellA\"", File.ReadAllText(full), StringComparison.Ordinal);
    }

    /// <summary>
    /// The mod header is a source file now (the root <c>RecordData.json</c>, ADR-0041's #444 amendment
    /// closing the "no source file" gap), so compile emits the header the tree holds. Before #454 the
    /// mod was built by <c>ModFactory.Activator</c> and the root document skipped outright, which
    /// silently dropped author, description and version on every compile.
    /// </summary>
    [Fact]
    public void Compile_CarriesTheModHeaderFromTheTree_RatherThanEmittingAFreshOne()
    {
        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.Equal(HeaderAuthor, mod.ModHeader.Author);
            Assert.Equal(HeaderDescription, mod.ModHeader.Description);
        }
    }
}
