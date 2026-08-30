using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

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
/// container is served from the indexed document, degraded, logged, never a crash. #453/#454 landed
/// field-edit and EditorID-rename support for a container's own scalar fields, verified below; delete,
/// create and renumber still refuse with <see cref="RecordEditRefusal.ContainerRecordNotYetSupported"/>,
/// naming that a container's own structural gestures aren't built yet — the same shape of refusal every
/// other blocked gesture on this write path already returns, not an unhandled exception or a 500.</para>
/// </summary>
public sealed class ContainerRecordRegressionTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_fixture.Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());

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
            "250.0", _fixture.Mirror.Index!.GetDocument(_fixture.Cell.ToString(), _fixture.Plugin)!.Body!, StringComparison.Ordinal);
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

    /// <summary>#461: delete now resolves a Cell's own directory through <see cref="SourceUnitResolver"/>
    /// instead of refusing outright — see <c>RecordEditServiceContainerDeleteRenumberTests</c> for the
    /// full cascade/embedded-child coverage this flip is a sibling of.</summary>
    [Fact]
    public void DeletingACell_Succeeds_NoLongerRefusesWithTheContainerRefusal()
    {
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Mirror.Index!.GetDocument(_fixture.Cell.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void CreatingANewCell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().CreateRecord(_fixture.Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    /// <summary>AC6 guard: the refusal's own message must stop naming this ticket now that delete and
    /// renumber no longer refuse container records — a message still saying "renumbering it do not
    /// yet (#461 delete/renumber...)" beside a Create call that in fact still refuses would send a user
    /// down a dead end that has since opened. #462 (the ticket that remains true) must still be
    /// named.</summary>
    [Fact]
    public void CreatingANewCell_RefusalMessage_NoLongerNamesDeleteOrRenumberAsUnsupported()
    {
        var result = EditService().CreateRecord(_fixture.Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.DoesNotContain("#461", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("renumbering it do not yet", result.Message, StringComparison.Ordinal);
        Assert.Contains("#462", result.Message, StringComparison.Ordinal);
    }

    /// <summary>#461: renumber now resolves a Cell's own directory the same way delete does — see
    /// <c>RecordEditServiceContainerDeleteRenumberTests</c> for the full coverage this flip is a
    /// sibling of.</summary>
    [Fact]
    public void RenumberingACell_Succeeds_NoLongerRefusesWithTheContainerRefusal()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Mirror.Index!.GetDocument(_fixture.Cell.ToString(), _fixture.Plugin));
        Assert.NotNull(_fixture.Mirror.Index!.GetDocument(result.NewFormKey!, _fixture.Plugin));
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

        ExternalChangeAbsorber.Absorb(_fixture.ModFolder, ContainerModFixture.PluginName, pluginPath, _fixture.Mirror.LoadOrder!);

        var afterMain = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "rev-parse", "main").Trim();
        Assert.NotEqual(beforeMain, afterMain);

        var tree = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();
        var root = SourceRecordPath.RootFor(ContainerModFixture.PluginName).Replace('\\', '/');
        Assert.Contains($"{root}/RecordData.json", tree);
        // The Cell that used to make this refuse, now written as its own directory-per-record unit.
        Assert.Contains(tree, f => f.StartsWith($"{root}/Cells/", StringComparison.Ordinal));
    }

    /// <summary>
    /// #460 (Keep half): renamed and re-explained from
    /// <c>KeepingAnExternalChange_OnAPluginWithACell_DoesNotThrow_AndSkipsTheCell</c> — that name and
    /// its comment described a container being <i>unconditionally</i> skipped, which stopped being true
    /// the moment <c>Keep</c> started resolving a container's existing source unit
    /// (<see cref="SourceUnitResolver"/>) instead of refusing on sight. This test still asserts the Cell
    /// does not land, but for the reason that now actually governs it: the binary is byte-for-byte what
    /// Track already committed, so <c>incoming == baseline</c> and there is nothing to land — the same
    /// "unchanged, so skip" rule a flat record gets. <see cref="KeepingAnExternalChange_OnAModifiedCell_LandsItOnItsExistingRecordDataJson"/>
    /// is the positive control this one needs beside it.
    /// </summary>
    [Fact]
    public void KeepingAnExternalChange_OnAnUnchangedCell_LandsNothing()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);

        var result = ExternalChangeEditLander.Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4,
            _fixture.Mirror.Index!, SharedSchemaReflector.Instance, NullLogger<ContainerRecordRegressionTests>.Instance);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.DoesNotContain(_fixture.Cell.ToString(), result.LandedFormKeys);
    }

    /// <summary>
    /// #460 (Keep half), AC1: a container already tracked in the source tree lands as working-tree
    /// dirt on its <b>existing</b> file, exactly like a flat record — the resolver
    /// (<see cref="SourceUnitResolver"/>) finds the Cell's own <c>RecordData.json</c>, so there is a
    /// file to land on and no reason to keep refusing.
    /// </summary>
    [Fact]
    public void KeepingAnExternalChange_OnAModifiedCell_LandsItOnItsExistingRecordDataJson()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        var file = _fixture.SourceFileContaining(ContainerModFixture.CellEditorId);
        Assert.Contains("\"WaterHeight\": 100.0", File.ReadAllText(file), StringComparison.Ordinal);

        MutateExternalBinary(pluginPath, mod => mod.Cells.Records
            .SelectMany(block => block.SubBlocks)
            .SelectMany(sub => sub.Cells)
            .Single(c => c.FormKey == _fixture.Cell).WaterHeight = 250f);

        var result = ExternalChangeEditLander.Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4,
            _fixture.Mirror.Index!, SharedSchemaReflector.Instance, NullLogger<ContainerRecordRegressionTests>.Instance);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Contains(_fixture.Cell.ToString(), result.LandedFormKeys);
        Assert.Contains("\"WaterHeight\": 250.0", File.ReadAllText(file), StringComparison.Ordinal);
    }

    /// <summary>
    /// #460 (Keep half), AC2: an embedded child's external change (here, a placed ref's own position,
    /// inside a Cell carrying all four embeddable slots at once) lands correctly even though it has no
    /// file of its own — it is inlined in its owner's document (#450), and the owner's own pass through
    /// the same <c>EnumerateMajorRecords</c> walk captures the aggregate text, so only the owner's own
    /// FormKey is reported landed (see this method's own second assertion — a deliberate, low-stakes
    /// design choice: <c>LandedFormKeys</c> is test-observability only, <c>ExternalChangeActionResponse</c>
    /// never carries it over the wire).
    /// </summary>
    [Fact]
    public void KeepingAnExternalChangeOnAnEmbeddedChild_LandsViaTheOwningCellsDocument()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        Assert.Contains("\"Position\": \"11, 22, 33\"", File.ReadAllText(file), StringComparison.Ordinal);

        MutateExternalBinary(pluginPath, mod =>
        {
            var cell = mod.Cells.Records.SelectMany(block => block.SubBlocks).SelectMany(sub => sub.Cells)
                .Single(c => c.FormKey == _fixture.EmbedCell);
            var placedRef = (PlacedObject)cell.Temporary.Single(r => r.FormKey == _fixture.TemporaryRef);
            placedRef.Position = new P3Float(999f, 22f, 33f);
        });

        var result = ExternalChangeEditLander.Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4,
            _fixture.Mirror.Index!, SharedSchemaReflector.Instance, NullLogger<ContainerRecordRegressionTests>.Instance);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Contains(_fixture.EmbedCell.ToString(), result.LandedFormKeys);
        Assert.DoesNotContain(_fixture.TemporaryRef.ToString(), result.LandedFormKeys);
        Assert.Contains("\"Position\": \"999, 22, 33\"", File.ReadAllText(file), StringComparison.Ordinal);
    }

    /// <summary>
    /// #460 (Keep half), AC3: a collision on an existing container refuses the whole gesture, exactly
    /// as it already does for a flat record — the same shared collision computation, unmodified.
    /// </summary>
    [Fact]
    public void KeepingAnExternalChange_CollidingWithACellsOwnWorkingTreeEdit_RefusesTheWholeGesture()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        var editResult = EditService().EditField(_fixture.Plugin, _fixture.Cell.ToString(), "water_height", Json("500.0"));
        Assert.True(editResult.Applied, editResult.Message);
        var myOwnEditText = File.ReadAllText(CellSourceFile);

        MutateExternalBinary(pluginPath, mod => mod.Cells.Records
            .SelectMany(block => block.SubBlocks)
            .SelectMany(sub => sub.Cells)
            .Single(c => c.FormKey == _fixture.Cell).WaterHeight = 250f);

        var result = ExternalChangeEditLander.Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4,
            _fixture.Mirror.Index!, SharedSchemaReflector.Instance, NullLogger<ContainerRecordRegressionTests>.Instance);

        Assert.False(result.Applied);
        Assert.Contains(_fixture.Cell.ToString(), result.RefusalReason, StringComparison.Ordinal);
        Assert.Equal(myOwnEditText, File.ReadAllText(CellSourceFile));
    }

    /// <summary>
    /// #460 (Keep half), residual scope: a container with no existing source unit anywhere in the tree
    /// — genuinely new, never tracked — is still skipped and logged, not landed and not a hard failure.
    /// Landing a brand-new container needs the layout grammar that places it (#454's territory), which
    /// this method deliberately does not have; the follow-up is tracked separately.
    /// </summary>
    [Fact]
    public void KeepingAnExternalChange_OnABrandNewNeverTrackedCell_SkipsItWithoutFailing()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        var brandNewCellKey = FormKey.Factory($"{0xD00:X6}:{ContainerModFixture.PluginName}");

        MutateExternalBinary(pluginPath, mod =>
        {
            var brandNewCell = new Cell(brandNewCellKey, Fallout4Release.Fallout4) { EditorID = "BrandNewCell" };
            var subBlock = new CellSubBlock { BlockNumber = 9, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(brandNewCell);
            var block = new CellBlock { BlockNumber = 9, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            mod.Cells.Records.Add(block);
        });

        var entries = new List<LogEntry>();
        var result = ExternalChangeEditLander.Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4,
            _fixture.Mirror.Index!, SharedSchemaReflector.Instance, new CollectingLogger(entries));

        Assert.True(result.Applied, result.RefusalReason);
        Assert.DoesNotContain(brandNewCellKey.ToString(), result.LandedFormKeys);
        Assert.Contains(entries, e => e.Message.Contains(brandNewCellKey.ToString(), StringComparison.Ordinal));
    }

    // Loads the plugin mutably (the same technique the whole-mod door itself uses to read a binary),
    // applies the mutation to the live object graph, then writes it back over the same path — the same
    // shape an external tool's own save would take, not a from-scratch reconstruction of the fixture.
    private static void MutateExternalBinary(string pluginPath, Action<Fallout4Mod> mutate)
    {
        var mod = (Fallout4Mod)ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        mutate(mod);
        mod.WriteToBinary(pluginPath);
    }
}
