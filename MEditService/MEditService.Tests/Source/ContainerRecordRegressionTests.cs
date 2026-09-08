using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Source;

/// <summary>Reading a container in a tracked plugin is served from the indexed document, degraded
/// and logged, never a crash; create refuses with a typed
/// <see cref="RecordEditRefusal.ContainerRecordNotYetSupported"/> rather than a 500.</summary>
public sealed class ContainerRecordRegressionTests : IDisposable
{
    private readonly IndexedContainerFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private ProjectingEditService EditService() =>
        ProjectingEditService.Over(_fixture.Index);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_fixture.Index, SharedSchemaReflector.Instance, new ConflictClassifier());

    // ---- Reads never throw on a container ----

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
        // A second real read path over the same container, not a duplicate assertion of GetRecord's.
        Assert.Null(Record.Exception(() => Reads().GetCompare(_fixture.Cell.ToString())));
    }

    // ---- Point writes refuse ----

    private string CellSourceFile => _fixture.SourceFileContaining(ContainerModFixture.CellEditorId);

    [Fact]
    public void EditingACellsOwnField_WritesItsRecordDataJson_AndChangesNothingElseInTheFile()
    {
        var file = CellSourceFile;
        var before = File.ReadAllText(file);
        Assert.Contains("\"WaterHeight\": 100.0", before, StringComparison.Ordinal);

        var result = EditService().Set(_fixture.Plugin, _fixture.Cell.ToString(), "WaterHeight", Json("250.0"));

        Assert.True(result.Applied, result.Message);
        // Every untouched byte is compared, which makes "only that field's lines diff" a measurement
        // rather than an assertion.
        Assert.Equal(
            before.Replace("\"WaterHeight\": 100.0", "\"WaterHeight\": 250.0", StringComparison.Ordinal),
            File.ReadAllText(file));
        // The source unit's own indexed document moved with the file.
        Assert.Contains(
            "250.0", _fixture.Index.Projected().GetDocument(_fixture.Cell.ToString(), _fixture.Plugin)!.Body!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACellsSourceFile_RoundTripsThroughThePerRecordCodecByteIdentically()
    {
        // A container's file read and rewritten with no edit comes back byte for byte, so any difference
        // the test above sees is the edit and nothing else.
        var file = CellSourceFile;
        var before = File.ReadAllBytes(file);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);

        var record = await codec.DeserializeAsync(file, GameRelease.Fallout4, "cell");
        var reserialized = await codec.SerializeToBytesAsync(record, GameRelease.Fallout4);

        Assert.Equal(before, reserialized);
    }

    [Fact]
    public void EditingACellsEditorId_MovesItsSourceDirectory_AndStagesAsARename()
    {
        var oldDirectory = Path.GetDirectoryName(CellSourceFile)!;
        Assert.EndsWith(ContainerModFixture.CellEditorId + " - " + FilesafeCellKey, oldDirectory, StringComparison.Ordinal);

        var result = EditService().Set(_fixture.Plugin, _fixture.Cell.ToString(), "EditorID", Json("\"RenamedCell\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        // The new directory is named by identity alone: a rename carries no position, because the cell's
        // slot lives in its sub-block's ordered child list keyed by FormKey, which a rename does not touch.
        var newDirectory = Path.Combine(
            Path.GetDirectoryName(oldDirectory)!, "RenamedCell - " + FilesafeCellKey);
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
    public void DeletingACell_Succeeds()
    {
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Index.Projected().GetDocument(_fixture.Cell.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void CreatingANewCell_RefusesWithTheContainerRefusal()
    {
        var result = EditService().CreateRecord(_fixture.Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void CreatingANewCell_RefusalMessage_NamesOnlyCreationAsUnsupported()
    {
        var result = EditService().CreateRecord(_fixture.Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.DoesNotContain("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("renumbering it do not yet", result.Message, StringComparison.Ordinal);
        Assert.Contains("creating one from scratch is not supported", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberingACell_Succeeds()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Index.Projected().GetDocument(_fixture.Cell.ToString(), _fixture.Plugin));
        Assert.NotNull(_fixture.Index.Projected().GetDocument(result.NewFormKey!, _fixture.Plugin));
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

    [Fact]
    public void AbsorbingAnExternalChange_OnAPluginWithACell_Succeeds_AndWritesACompleteBaseline()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        var beforeMain = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "rev-parse", "main").Trim();

        TestEditService.AbsorbHandler().Absorb(
            _fixture.ModFolder, ContainerModFixture.PluginName, pluginPath, LoadOrder.From(_fixture.Index.LoadOrder!));

        var afterMain = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "rev-parse", "main").Trim();
        Assert.NotEqual(beforeMain, afterMain);

        var tree = GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();
        var root = SourceRepository.RootFor(ContainerModFixture.PluginName).Replace('\\', '/');
        Assert.Contains($"{root}/RecordData.json", tree);
        // The Cell, written as its own directory-per-record unit.
        Assert.Contains(tree, f => f.StartsWith($"{root}/Cells/", StringComparison.Ordinal));
    }

    [Fact]
    public void KeepingAnExternalChange_OnAnUnchangedCell_LandsNothing()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);

        var result = TestEditService.KeepHandler().Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.DoesNotContain(_fixture.Cell.ToString(), result.LandedFormKeys);
    }

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

        var result = TestEditService.KeepHandler().Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Contains(_fixture.Cell.ToString(), result.LandedFormKeys);
        Assert.Contains("\"WaterHeight\": 250.0", File.ReadAllText(file), StringComparison.Ordinal);
    }

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

        var result = TestEditService.KeepHandler().Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Contains(_fixture.EmbedCell.ToString(), result.LandedFormKeys);
        Assert.DoesNotContain(_fixture.TemporaryRef.ToString(), result.LandedFormKeys);
        Assert.Contains("\"Position\": \"999, 22, 33\"", File.ReadAllText(file), StringComparison.Ordinal);
    }

    [Fact]
    public void KeepingAnExternalChange_CollidingWithACellsOwnWorkingTreeEdit_RefusesTheWholeGesture()
    {
        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        var editResult = EditService().Set(_fixture.Plugin, _fixture.Cell.ToString(), "WaterHeight", Json("500.0"));
        Assert.True(editResult.Applied, editResult.Message);
        var myOwnEditText = File.ReadAllText(CellSourceFile);

        MutateExternalBinary(pluginPath, mod => mod.Cells.Records
            .SelectMany(block => block.SubBlocks)
            .SelectMany(sub => sub.Cells)
            .Single(c => c.FormKey == _fixture.Cell).WaterHeight = 250f);

        var result = TestEditService.KeepHandler().Keep(
            _fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4);

        Assert.False(result.Applied);
        Assert.Contains(_fixture.Cell.ToString(), result.RefusalReason, StringComparison.Ordinal);
        Assert.Equal(myOwnEditText, File.ReadAllText(CellSourceFile));
    }

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
        var handler = TestEditService.KeepHandler(
            b => b.SetMinimumLevel(LogLevel.Trace).AddProvider(new CollectingLoggerProvider(entries)));

        var result = handler.Keep(_fixture.ModFolder, _fixture.Plugin, pluginPath, GameRelease.Fallout4);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.DoesNotContain(brandNewCellKey.ToString(), result.LandedFormKeys);
        Assert.Contains(entries, e => e.Message.Contains(brandNewCellKey.ToString(), StringComparison.Ordinal));
    }

    // Loads the plugin mutably, applies the mutation to the live object graph, then writes it back over
    // the same path: the shape an external tool's own save takes, not a from-scratch reconstruction.
    private static void MutateExternalBinary(string pluginPath, Action<Fallout4Mod> mutate)
    {
        var mod = (Fallout4Mod)ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        mutate(mod);
        mod.WriteToBinary(pluginPath);
    }
}
