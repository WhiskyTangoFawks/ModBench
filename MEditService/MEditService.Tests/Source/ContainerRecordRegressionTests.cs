using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>
/// #451 review, finding 2: <see cref="SourceRecordPath.For"/> throws <see cref="NotSupportedException"/>
/// for a container record (Cell/Worldspace/Quest — no flat path), and before this suite existed nothing
/// caught it on the read path (<see cref="SourceFreshness"/>) or the point-write path
/// (<see cref="RecordEditService"/>) — a real regression the shared <c>TrackedModFixture</c> (Npc/Race/
/// Keyword only) could never surface, which is exactly why this is its own small local fixture with a
/// real Cell, per the review's own instruction not to add one to the shared fixture (risking the other
/// 24 files it feeds).
///
/// <para><b>What a user now sees editing a cell in a tracked plugin</b> (the sentence the review asked
/// for, verified by the tests below): reading it (record editor, compare grid) still works — the
/// container is served from the indexed document, degraded, logged, never a crash. Every write gesture
/// (field edit, delete, create, renumber) refuses with <see cref="RecordEditRefusal.ContainerRecordNotYetSupported"/>,
/// naming that point-write support for containers isn't built yet (#453) — the same shape of refusal
/// every other blocked gesture on this write path already returns, not an unhandled exception or a
/// 500.</para>
/// </summary>
public sealed class ContainerRecordRegressionTests : IDisposable
{
    private const string PluginName = "CellFixture.esp";
    private const string Origin = "CellFixtureMod";

    public string ModFolder { get; }
    private readonly string _gameDirectory;
    public SessionManager Sessions { get; }
    public PluginKey Plugin { get; } = new(PluginName, Origin);
    public FormKey Cell { get; }
    public FormKey Npc { get; }

    public ContainerRecordRegressionTests()
    {
        ModFolder = Directory.CreateTempSubdirectory("medit-container-regress-").FullName;
        _gameDirectory = Directory.CreateTempSubdirectory("medit-container-regress-game-").FullName;

        var pluginPath = Path.Combine(ModFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var cell = new Cell(mod) { EditorID = "FixtureCell" };
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        var npc = mod.Npcs.AddNew("FixtureNpc");
        mod.WriteToBinary(pluginPath);
        (Cell, Npc) = (cell.FormKey, npc.FormKey);

        Sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)Sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(PluginName, pluginPath, Origin, true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(Sessions.Session!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        Sessions.Dispose();
        TryDelete(ModFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    private RecordEditService EditService() =>
        new(Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordQueryService Reads() =>
        new RecordQueryService(Sessions, SharedSchemaReflector.Instance, new ConflictClassifier());

    // ---- Reads degrade (SourceFreshness) ----

    [Fact]
    public void ReadingACellInATrackedPlugin_DoesNotThrow_AndServesTheIndexedDocument()
    {
        var record = Reads().GetRecord(Cell.ToString());

        Assert.NotNull(record);
        Assert.Equal("FixtureCell", record!.EditorId);
    }

    [Fact]
    public void ReadingACellsCompareGrid_DoesNotThrow()
    {
        // GetCompare drives SourceFreshness.Validate exactly like GetRecord — a second real read path
        // that must not crash on a container, not a duplicate assertion of the same code path.
        Assert.Null(Record.Exception(() => Reads().GetCompare(Cell.ToString())));
    }

    // ---- Point writes refuse (RecordEditService) ----

    [Fact]
    public void EditingACellsField_RefusesWithTheContainerRefusal_NotAnException()
    {
        var result = EditService().EditField(Plugin, Cell.ToString(), "editorID", System.Text.Json.JsonDocument.Parse("\"Renamed\"").RootElement);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
        Assert.Contains("453", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeletingACell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().DeleteRecord(Plugin, Cell.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
        // No half-applied state: the refusal fires before anything is touched.
        Assert.NotNull(Sessions.Index!.GetDocument(Cell.ToString(), Plugin));
    }

    [Fact]
    public void CreatingANewCell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().CreateRecord(Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void RenumberingACell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().RenumberRecord(Plugin, Cell.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void RenumberingAPlainRecordReferencedByNothing_StillWorks_ContainerGuardIsScopedNotBlanket()
    {
        // Positive control: the container guard must not blanket-refuse renumber for a plugin that
        // merely *holds* a cell elsewhere — only the record actually being touched (target or
        // referencer) is checked.
        var result = EditService().RenumberRecord(Plugin, Npc.ToString());

        Assert.True(result.Applied, result.Message);
    }

    // ---- External-change exits (Absorb refuses wholesale, Keep skips) ----

    [Fact]
    public void AbsorbingAnExternalChange_OnAPluginWithACell_ThrowsNamedException_AndWritesNothing()
    {
        var pluginPath = Path.Combine(ModFolder, PluginName);
        var beforeMain = GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "rev-parse", "main").Trim();

        var ex = Assert.Throws<ContainerRecordsNotYetSupportedException>(() =>
            ExternalChangeAbsorber.Absorb(ModFolder, PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance));

        Assert.Contains("453", ex.Message, StringComparison.Ordinal);
        var afterMain = GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "rev-parse", "main").Trim();
        Assert.Equal(beforeMain, afterMain);
    }

    [Fact]
    public void KeepingAnExternalChange_OnAPluginWithACell_DoesNotThrow_AndSkipsTheCell()
    {
        var pluginPath = Path.Combine(ModFolder, PluginName);

        var result = ExternalChangeEditLander.Keep(
            ModFolder, PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance, NullLogger<ContainerRecordRegressionTests>.Instance);

        // Nothing actually changed in the binary since Track, so nothing lands either way — the load-
        // bearing assertion is the one above this: it ran to completion without throwing.
        Assert.True(result.Applied);
        Assert.DoesNotContain(Cell.ToString(), result.LandedFormKeys);
    }
}
