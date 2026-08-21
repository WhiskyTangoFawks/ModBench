using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Source;

/// <summary>
/// #452 AC3 at the container seam: a Cell's <b>embedded</b> children — the placed references Spriggit
/// writes inline into the parent document rather than as files of their own — are still their own
/// queryable records after a tracked plugin is ingested from its source tree, at both refs.
///
/// <para><b>Its own local fixture, deliberately.</b> The shared <c>TrackedModFixture</c> holds
/// Npc/Race/Keyword and no containers at all, so it structurally cannot exercise any of this — which
/// is exactly how #451 shipped a container regression no test could see. Modifying it would put 25
/// other test files at risk for no benefit, so this follows
/// <see cref="ContainerRecordRegressionTests"/>' precedent of a small local Cell fixture instead.
/// (<c>SourceIngestParityTests</c> covers the same ground across 2,577 real records; this suite is the
/// fast, readable statement of the specific property.)</para>
/// </summary>
public sealed class SourceIngestContainerTests : IDisposable
{
    private const string PluginName = "CellIngest.esp";
    private const string Origin = "CellIngestMod";

    private readonly string _modFolder;
    private readonly string _gameDirectory;
    private readonly SessionManager _seed;
    private readonly PluginKey _plugin = new(PluginName, Origin);
    private readonly FormKey _cell;
    private readonly FormKey _placed;

    public SourceIngestContainerTests()
    {
        _modFolder = Directory.CreateTempSubdirectory("medit-source-container-").FullName;
        _gameDirectory = Directory.CreateTempSubdirectory("medit-source-container-game-").FullName;

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var cell = new Cell(mod) { EditorID = "IngestCell" };
        // Temporary, not Persistent: this is one of the five slots Spriggit embeds inline, so the
        // child has no source file of its own and can only reach the index through its parent's
        // document — which is the whole property under test.
        var placed = new PlacedObject(mod) { EditorID = "IngestRef", Position = new P3Float(11f, 22f, 33f) };
        cell.Temporary.Add(placed);

        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        mod.Npcs.AddNew("IngestNpc");
        mod.WriteToBinary(pluginPath);
        (_cell, _placed) = (cell.FormKey, placed.FormKey);

        _seed = NewSession();
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_seed.Session!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    private SessionManager NewSession()
    {
        var sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(PluginName, Path.Combine(_modFolder, PluginName), Origin, true)],
            GameRelease.Fallout4);
        return sessions;
    }

    private string SourceRoot => Path.Combine(_modFolder, $"{PluginName}{SourceRecordPath.SourceSuffix}");

    /// <summary>The Cell's own source file. Under the Spriggit layout a Cell is a directory-per-record
    /// container (<c>Cells/&lt;block&gt;/&lt;subblock&gt;/&lt;name&gt;/RecordData.json</c>), so it is
    /// found by content rather than by <see cref="SourceRecordPath.For"/>, which has no flat path for
    /// one and throws by design.</summary>
    private string CellSourceFile =>
        Directory.EnumerateFiles(SourceRoot, "RecordData.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains("\"IngestCell\"", StringComparison.Ordinal));

    public void Dispose()
    {
        _seed.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    // ---- AC3: embedded children survive the round trip through the tree ----

    [Fact]
    public void AnEmbeddedPlacedReference_IsItsOwnRecord_AfterIngestFromSource()
    {
        using var reloaded = NewSession();

        var record = reloaded.Index!.GetDocument(_placed.ToString(), _plugin);
        Assert.NotNull(record);
        Assert.Equal("IngestRef", record!.EditorId);
        Assert.NotNull(reloaded.Index!.Resolve(_placed.ToString()));
    }

    [Fact]
    public void AnEmbeddedPlacedReference_KeepsItsPlacementRow_AfterIngestFromSource()
    {
        using var reloaded = NewSession();

        var placement = reloaded.Index!.GetPlacement(_placed.ToString(), _plugin);
        Assert.NotNull(placement);
        // The spatial facts survive containment being expressed as a directory rather than a GRUP.
        Assert.Equal(_cell.ToString(), placement!.Value.ParentCell);
        Assert.Equal(11f, placement.Value.PosX);
    }

    [Fact]
    public void AnEmbeddedPlacedReference_AnswersAtBothRefs_OnACleanTree()
    {
        using var reloaded = NewSession();

        // Nothing is dirty, so the one parse serves both refs — ADR-0041's clean fast path, asserted
        // rather than assumed, and asserted for a record that exists only inside its parent's document.
        var effective = reloaded.Index!.GetDocument(_placed.ToString(), _plugin);
        var head = reloaded.Index!.At(RecordRef.Head).GetDocument(_placed.ToString(), _plugin);
        Assert.NotNull(head);
        Assert.Equal(effective!.Body, head!.Body);
    }

    [Fact]
    public void TheCellItself_AnswersAfterIngestFromSource()
    {
        using var reloaded = NewSession();

        var cell = reloaded.Index!.GetDocument(_cell.ToString(), _plugin);
        Assert.NotNull(cell);
        Assert.Equal("IngestCell", cell!.EditorId);
        // The child is embedded in the parent's document, which is what gives it no file of its own.
        Assert.Contains("IngestRef", cell.Body, StringComparison.Ordinal);
    }

    // ---- The pinned #453/#454 limitation ----

    /// <summary>
    /// A container edited in the working tree is read correctly at Effective, but its <b>Head</b> state
    /// is not reconciled — so it reads <i>clean</i> when it is in fact dirty.
    ///
    /// <para>This is a known, bounded gap, pinned here rather than left silent.
    /// <c>SourceIngest.ReconcileHead</c> identifies a dirty source unit through
    /// <see cref="SourceRecordPath.TryParse"/>, which fails closed for every container path by design:
    /// recovering a record type from <c>Cells/&lt;b&gt;/&lt;sb&gt;/&lt;name&gt;/RecordData.json</c> or
    /// <c>Quests/&lt;n&gt;/DialogTopics/&lt;n&gt;/RecordData.json</c> needs the structure-aware reader
    /// #453/#454 own — a Quest's own directory and its DialogTopics children share a group-folder
    /// segment, so position alone cannot tell them apart. It degrades and logs; it never throws, which
    /// is the part that matters for a session load.</para>
    ///
    /// <para>When #453/#454 land, this test should go red and be replaced by the real assertion (Head
    /// holds the committed bytes). That is the intended lifecycle, not a regression.</para>
    /// </summary>
    [Fact]
    public void AnExternallyEditedContainer_IsCorrectAtEffective_ButItsHeadStateIsNotYetReconciled()
    {
        var file = CellSourceFile;
        File.WriteAllText(file, File.ReadAllText(file).Replace("IngestCell", "RenamedCell", StringComparison.Ordinal));

        using var reloaded = NewSession();

        // The load completed and the edit is visible — no throw, no dropped plugin, no fallback.
        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal("RenamedCell", reloaded.Index!.GetDocument(_cell.ToString(), _plugin)!.EditorId);

        // The gap: Head should hold "IngestCell" and does not, because the container's dirty path was
        // skipped by the reconciliation pass. Asserted as-is so the day it changes, we are told.
        Assert.Equal(
            "RenamedCell",
            reloaded.Index!.At(RecordRef.Head).GetDocument(_cell.ToString(), _plugin)!.EditorId);
    }

    /// <summary>The positive control for the test above: a <i>flat</i> record edited in the same tree
    /// does reconcile, so "Head was not reconciled" is specific to containers rather than the
    /// reconciliation pass being broken outright.</summary>
    [Fact]
    public void AFlatRecordEditedBesideTheContainer_DoesReconcileItsHead()
    {
        var npc = _seed.Index!.Search(new RecordQuery(Plugin: _plugin, Limit: 100))
            .Items.Single(r => r.EditorId == "IngestNpc");
        var npcFile = Path.Combine(_modFolder,
            SourceRecordPath.For(PluginName, "npc_", npc.FormKey, "IngestNpc", GameRelease.Fallout4));
        File.WriteAllText(npcFile, File.ReadAllText(npcFile).Replace("IngestNpc", "RenamedNpc", StringComparison.Ordinal));

        using var reloaded = NewSession();

        Assert.Equal("RenamedNpc", reloaded.Index!.GetDocument(npc.FormKey, _plugin)!.EditorId);
        Assert.Equal("IngestNpc", reloaded.Index!.At(RecordRef.Head).GetDocument(npc.FormKey, _plugin)!.EditorId);
    }
}
