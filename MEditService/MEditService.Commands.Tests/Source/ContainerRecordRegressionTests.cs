using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Commands.Tests.Source;

/// <summary>Create refuses a container with a typed
/// <see cref="RecordEditRefusal.ContainerRecordNotYetSupported"/> rather than a 500; edit, delete
/// and a FormID edit write and read back through the Source repository.</summary>
public sealed class ContainerRecordRegressionTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string CellSourceFile => _fixture.SourceFileContaining(ContainerModPlugin.CellEditorId);

    [Fact]
    public void EditingACellsOwnField_WritesItsRecordDataJson_AndChangesNothingElseInTheFile()
    {
        var file = CellSourceFile;
        var before = File.ReadAllText(file);
        Assert.Contains("\"WaterHeight\": 100.0", before, StringComparison.Ordinal);

        var result = _fixture.EditHandler.Set(_fixture.Plugin, _fixture.Cell.ToString(), "WaterHeight", Json("250.0"));

        Assert.True(result.Applied, result.Message);
        // Every untouched byte is compared, which makes "only that field's lines diff" a measurement
        // rather than an assertion.
        Assert.Equal(
            before.Replace("\"WaterHeight\": 100.0", "\"WaterHeight\": 250.0", StringComparison.Ordinal),
            File.ReadAllText(file));
    }

    [Fact]
    public void ACellsSourceFile_RoundTripsThroughThePerRecordCodecByteIdentically()
    {
        // A container's file read and rewritten with no edit comes back byte for byte, so any difference
        // the test above sees is the edit and nothing else.
        var file = CellSourceFile;
        var before = File.ReadAllBytes(file);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);

        var record = codec.DeserializeFile(file, GameRelease.Fallout4, "cell");
        var reserialized = codec.SerializeToBytes(record, GameRelease.Fallout4);

        Assert.Equal(before, reserialized);
    }

    [Fact]
    public void EditingACellsEditorId_MovesItsSourceDirectory_AndStagesAsARename()
    {
        var cellSourceFile = CellSourceFile;
        var oldDirectory = Path.GetDirectoryName(cellSourceFile)
            ?? throw new InvalidOperationException($"Expected '{cellSourceFile}' to have a parent directory.");
        Assert.EndsWith(ContainerModPlugin.CellEditorId + " - " + FilesafeCellKey, oldDirectory, StringComparison.Ordinal);

        var result = _fixture.EditHandler.Set(_fixture.Plugin, _fixture.Cell.ToString(), "EditorID", Json("\"RenamedCell\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        // The new directory is named by identity alone: a rename carries no position, because the cell's
        // slot lives in its sub-block's ordered child list keyed by FormKey, which a rename does not touch.
        var newDirectory = Path.Combine(
            Path.GetDirectoryName(oldDirectory) ?? throw new InvalidOperationException($"Expected '{oldDirectory}' to have a parent directory."), "RenamedCell - " + FilesafeCellKey);
        Assert.True(Directory.Exists(newDirectory));
        Assert.Contains(
            "\"EditorID\": \"RenamedCell\"",
            File.ReadAllText(Path.Combine(newDirectory, "RecordData.json")),
            StringComparison.Ordinal);

        var git = Path.Combine(_fixture.ModFolder, ".git");
        GitProbe.Run(git, _fixture.ModFolder, "add", "-A");
        var staged = GitProbe.Run(git, _fixture.ModFolder, "diff", "--cached", "-M", "--name-status")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

        var rename = Assert.Single(staged, l => l.StartsWith('R'));
        Assert.Contains(ContainerModPlugin.CellEditorId, rename, StringComparison.Ordinal);
        Assert.Contains("RenamedCell", rename, StringComparison.Ordinal);
    }

    private string FilesafeCellKey => $"{_fixture.Cell.ID:X6}_{_fixture.Cell.ModKey.FileName}";

    private static System.Text.Json.JsonElement Json(string raw) =>
        System.Text.Json.JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void DeletingACell_Succeeds()
    {
        var result = _fixture.DeleteHandler.DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.Cell.ToString())]);

        Assert.Empty(result.Refused);
        Assert.Null(_fixture.Document(_fixture.Cell.ToString()));
    }

    [Fact]
    public void CreatingANewCell_RefusesWithTheContainerRefusal()
    {
        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void CreatingANewCell_RefusalMessage_NamesOnlyCreationAsUnsupported()
    {
        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "cell", "BrandNewCell");

        Assert.False(result.Applied);
        Assert.DoesNotContain("structural gesture", result.Message, StringComparison.Ordinal);
        Assert.Contains("creating one from scratch is not supported", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingTheFormIdOfACell_Succeeds()
    {
        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.Cell.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Document(_fixture.Cell.ToString()));
        var newFormKey = result.NewFormKey ?? throw new InvalidOperationException("Expected a FormID edit to answer the new FormKey.");
        Assert.NotNull(_fixture.Document(newFormKey));
    }

    [Fact]
    public void EditingTheFormIdOfAPlainRecord_InAPluginHoldingACell_Succeeds()
    {
        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.Npc.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
    }
}
