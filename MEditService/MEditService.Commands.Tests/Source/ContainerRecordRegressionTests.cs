using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Commands.Tests.Source;

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
        Assert.Equal(
            before.Replace("\"WaterHeight\": 100.0", "\"WaterHeight\": 250.0", StringComparison.Ordinal),
            File.ReadAllText(file));
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
        var newDirectoryNamedByIdentityAlone = Path.Combine(
            Path.GetDirectoryName(oldDirectory) ?? throw new InvalidOperationException($"Expected '{oldDirectory}' to have a parent directory."), "RenamedCell - " + FilesafeCellKey);
        Assert.True(Directory.Exists(newDirectoryNamedByIdentityAlone));
        Assert.Contains(
            "\"EditorID\": \"RenamedCell\"",
            File.ReadAllText(Path.Combine(newDirectoryNamedByIdentityAlone, "RecordData.json")),
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
    public void EditingTheFormIdOfAPlainRecord_InAPluginHoldingACell_Succeeds()
    {
        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.Npc.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
    }
}
