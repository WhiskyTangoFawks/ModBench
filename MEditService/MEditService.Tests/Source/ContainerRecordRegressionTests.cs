using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
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

        // WaterHeight: a plain nullable float, given a value at Track time so the point-write tests
        // below have a field whose textual before/after they can compare byte for byte (#453 AC1).
        // Left null it would serialize as a null literal, and the substitution assertion would be
        // measuring the serializer's null handling rather than the edit.
        var cell = new Cell(mod) { EditorID = "FixtureCell", WaterHeight = 100f };
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

    /// <summary>The Cell's own source file, found by walking the tree rather than by
    /// <see cref="SourceRecordPath.For"/> (which has no flat path for a container and throws by
    /// design) — the test's own independent locator, deliberately <b>not</b> <c>SourceUnitResolver</c>,
    /// so it cannot agree with the code under test by construction.</summary>
    private string CellSourceFile =>
        Directory.EnumerateFiles(
                Path.Combine(ModFolder, $"{PluginName}{SourceRecordPath.SourceSuffix}"),
                "RecordData.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains("\"FixtureCell\"", StringComparison.Ordinal));

    [Fact]
    public void EditingACellsOwnField_WritesItsRecordDataJson_AndChangesNothingElseInTheFile()
    {
        var file = CellSourceFile;
        var before = File.ReadAllText(file);
        Assert.Contains("100.0", before, StringComparison.Ordinal);

        var result = EditService().EditField(Plugin, Cell.ToString(), "water_height", Json("250.0"));

        Assert.True(result.Applied, result.Message);
        // AC1, in its strongest form: the whole file is byte-identical outside the one field's own
        // text. Not a diff-line count — every untouched byte is compared, which is what makes
        // "only that field's line(s) diff" a measurement rather than an assertion.
        Assert.Equal(before.Replace("100.0", "250.0", StringComparison.Ordinal), File.ReadAllText(file));
        // Scope 4: the source unit's own indexed document moved with the file.
        Assert.Contains("250.0", Sessions.Index!.GetDocument(Cell.ToString(), Plugin)!.Body!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACellsSourceFile_RoundTripsThroughThePerRecordCodecByteIdentically()
    {
        // The property AC1 rests on: a container's file read and rewritten with no edit at all comes
        // back byte for byte, so any difference the test above sees is the edit and nothing else.
        // DocumentShapeParityTests pins the *serialize* half against the whole-mod door; this pins
        // the deserialize→serialize round trip on a file that door actually wrote.
        var file = CellSourceFile;
        var before = File.ReadAllBytes(file);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);

        var record = await codec.DeserializeAsync(file, GameRelease.Fallout4, "cell");
        var reserialized = await codec.SerializeToBytesAsync(record, GameRelease.Fallout4);

        Assert.Equal(before, reserialized);
    }

    /// <summary>#453 scope 3 / AC2, container half: a container's EditorID is carried by its
    /// <i>directory</i> name, not a file name, so the rename is a directory move — which also carries
    /// whatever folder-split children live inside it (a Quest's dialog topics) rather than orphaning
    /// them. See <c>RecordEditServiceTests.EditingEditorId_ShowsAsARenameOnceStaged_NotADeleteAndAdd</c>
    /// for why the staged form is what AC2 can be asserted against at all.</summary>
    [Fact]
    public void EditingACellsEditorId_MovesItsSourceDirectory_AndStagesAsARename()
    {
        var oldDirectory = Path.GetDirectoryName(CellSourceFile)!;
        Assert.EndsWith("FixtureCell - " + FilesafeCellKey, oldDirectory, StringComparison.Ordinal);

        var result = EditService().EditField(Plugin, Cell.ToString(), "editor_id", Json("\"RenamedCell\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        var newDirectory = Path.Combine(Path.GetDirectoryName(oldDirectory)!, "RenamedCell - " + FilesafeCellKey);
        Assert.True(Directory.Exists(newDirectory));
        Assert.Contains(
            "\"EditorID\": \"RenamedCell\"",
            File.ReadAllText(Path.Combine(newDirectory, "RecordData.json")),
            StringComparison.Ordinal);

        var git = Path.Combine(ModFolder, ".git");
        GitCli.Run(git, ModFolder, "add", "-A");
        var staged = GitCli.Run(git, ModFolder, "diff", "--cached", "-M", "--name-status")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

        var rename = Assert.Single(staged, l => l.StartsWith('R'));
        Assert.Contains("FixtureCell", rename, StringComparison.Ordinal);
        Assert.Contains("RenamedCell", rename, StringComparison.Ordinal);
    }

    private string FilesafeCellKey => $"{Cell.ID:X6}_{Cell.ModKey.FileName}";

    private static System.Text.Json.JsonElement Json(string raw) =>
        System.Text.Json.JsonDocument.Parse(raw).RootElement;

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
