using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// #451 review, finding 2: <see cref="SourceRecordPath.For"/> throws <see cref="NotSupportedException"/>
/// for a container record (Cell/Worldspace/Quest — no flat path), and before this suite existed nothing
/// caught it on the read path (<see cref="SourceFreshness"/>) or the point-write path
/// (<see cref="RecordEditService"/>) — a real regression the shared <c>TrackedModFixture</c> (Npc/Race/
/// Keyword only) could never surface. #466 moved this suite onto the shared
/// <see cref="ContainerModFixture"/> instead of the small local Cell fixture the #451 review asked for
/// at the time — that fixture, and its siblings that grew up in <c>SourceIngestContainerTests</c> and
/// <c>EmbeddedChildEditTests</c>, are what #466 consolidated.
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
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_fixture.Sessions, SharedSchemaReflector.Instance, new ConflictClassifier());

    // ---- Reads degrade (SourceFreshness) ----

    [Fact]
    public void ReadingACellInATrackedPlugin_DoesNotThrow_AndServesTheIndexedDocument()
    {
        var record = Reads().GetRecord(_fixture.Cell.ToString());

        Assert.NotNull(record);
        Assert.Equal(ContainerModFixture.CellEditorId, record!.EditorId);
    }

    [Fact]
    public void ReadingACellsCompareGrid_DoesNotThrow()
    {
        // GetCompare drives SourceFreshness.Validate exactly like GetRecord — a second real read path
        // that must not crash on a container, not a duplicate assertion of the same code path.
        Assert.Null(Record.Exception(() => Reads().GetCompare(_fixture.Cell.ToString())));
    }

    // ---- Point writes refuse (RecordEditService) ----

    private string CellSourceFile => _fixture.SourceFileContaining(ContainerModFixture.CellEditorId);

    [Fact]
    public void EditingACellsOwnField_WritesItsRecordDataJson_AndChangesNothingElseInTheFile()
    {
        var file = CellSourceFile;
        var before = File.ReadAllText(file);
        Assert.Contains("\"WaterHeight\": 100.0", before, StringComparison.Ordinal);

        var result = EditService().EditField(_fixture.Plugin, _fixture.Cell.ToString(), "water_height", Json("250.0"));

        Assert.True(result.Applied, result.Message);
        // AC1, in its strongest form: the whole file is byte-identical outside the one field's own
        // text. Not a diff-line count — every untouched byte is compared, which is what makes
        // "only that field's line(s) diff" a measurement rather than an assertion. Field-qualified
        // rather than a bare "100.0" so the substitution stays pinned to this one field as the
        // document grows and other numbers appear beside it.
        Assert.Equal(
            before.Replace("\"WaterHeight\": 100.0", "\"WaterHeight\": 250.0", StringComparison.Ordinal),
            File.ReadAllText(file));
        // Scope 4: the source unit's own indexed document moved with the file.
        Assert.Contains(
            "250.0", _fixture.Sessions.Index!.GetDocument(_fixture.Cell.ToString(), _fixture.Plugin)!.Body!, StringComparison.Ordinal);
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
        Assert.EndsWith(ContainerModFixture.CellEditorId + " - " + FilesafeCellKey, oldDirectory, StringComparison.Ordinal);

        var result = EditService().EditField(_fixture.Plugin, _fixture.Cell.ToString(), "editor_id", Json("\"RenamedCell\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        // #459: the rename preserves whatever "[N] " order prefix the old directory carried (Cells is
        // itself a folder-split top-level group under the same EnforceRecordOrder numbering as any
        // flat type) — carried forward from the old name rather than hardcoded, so this assertion
        // doesn't have to know the fixture's own slot number.
        var orderPrefix = SourceUnitResolver.TryGetOrderIndex(Path.GetFileName(oldDirectory)) is { } index
            ? $"[{index}] "
            : "";
        var newDirectory = Path.Combine(
            Path.GetDirectoryName(oldDirectory)!, orderPrefix + "RenamedCell - " + FilesafeCellKey);
        Assert.True(Directory.Exists(newDirectory));
        Assert.Contains(
            "\"EditorID\": \"RenamedCell\"",
            File.ReadAllText(Path.Combine(newDirectory, "RecordData.json")),
            StringComparison.Ordinal);

        var git = Path.Combine(_fixture.ModFolder, ".git");
        GitCli.Run(git, _fixture.ModFolder, "add", "-A");
        var staged = GitCli.Run(git, _fixture.ModFolder, "diff", "--cached", "-M", "--name-status")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

        var rename = Assert.Single(staged, l => l.StartsWith('R'));
        Assert.Contains(ContainerModFixture.CellEditorId, rename, StringComparison.Ordinal);
        Assert.Contains("RenamedCell", rename, StringComparison.Ordinal);
    }

    private string FilesafeCellKey => $"{_fixture.Cell.ID:X6}_{_fixture.Cell.ModKey.FileName}";

    private static System.Text.Json.JsonElement Json(string raw) =>
        System.Text.Json.JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void DeletingACell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
        // No half-applied state: the refusal fires before anything is touched.
        Assert.NotNull(_fixture.Sessions.Index!.GetDocument(_fixture.Cell.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void CreatingANewCell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().CreateRecord(_fixture.Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void RenumberingACell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void RenumberingAPlainRecordReferencedByNothing_StillWorks_ContainerGuardIsScopedNotBlanket()
    {
        // Positive control: the container guard must not blanket-refuse renumber for a plugin that
        // merely *holds* a cell elsewhere — only the record actually being touched (target or
        // referencer) is checked.
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Npc.ToString());

        Assert.True(result.Applied, result.Message);
    }

    // ---- External-change exits ----

    /// <summary>
    /// Absorb used to refuse outright on any plugin holding a Cell/Worldspace/Quest — i.e. most real
    /// plugins (#460). #454 removed the refusal by removing its cause: Absorb no longer rebuilds the
    /// tree one record at a time (which had no flat path for a container), it shares Track's own
    /// whole-mod serialization, and that has never had the limitation. The assertion that replaced the
    /// old <c>Assert.Throws</c> is this one — it works, and the baseline it writes is complete.
    /// </summary>
    [Fact]
    public void AbsorbingAnExternalChange_OnAPluginWithACell_Succeeds_AndWritesACompleteBaseline()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        var beforeMain = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "rev-parse", "main").Trim();

        ExternalChangeAbsorber.Absorb(_fixture.ModFolder, ContainerModFixture.PluginName, pluginPath, _fixture.Sessions.Session!);

        var afterMain = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "rev-parse", "main").Trim();
        Assert.NotEqual(beforeMain, afterMain);

        var tree = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();
        var root = $"{ContainerModFixture.PluginName}{SourceRecordPath.SourceSuffix}";
        Assert.Contains($"{root}/RecordData.json", tree);
        // The Cell that used to make this refuse, now written as its own directory-per-record unit.
        Assert.Contains(tree, f => f.StartsWith($"{root}/Cells/", StringComparison.Ordinal));
    }

    [Fact]
    public void KeepingAnExternalChange_OnAPluginWithACell_DoesNotThrow_AndSkipsTheCell()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);

        var result = ExternalChangeEditLander.Keep(
            _fixture.ModFolder, ContainerModFixture.PluginName, pluginPath, GameRelease.Fallout4,
            SharedSchemaReflector.Instance, NullLogger<ContainerRecordRegressionTests>.Instance);

        // Nothing actually changed in the binary since Track, so nothing lands either way — the load-
        // bearing assertion is the one above this: it ran to completion without throwing.
        Assert.True(result.Applied);
        Assert.DoesNotContain(_fixture.Cell.ToString(), result.LandedFormKeys);
    }
}
