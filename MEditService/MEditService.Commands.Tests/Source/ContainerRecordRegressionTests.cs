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

    private string CellText() => _fixture.Document(_fixture.Cell.ToString()).Require().Body;

    [Fact]
    public void EditingACellsOwnField_ChangesNothingElseInItsDocument()
    {
        var before = CellText();
        Assert.Contains("\"WaterHeight\": 100.0", before, StringComparison.Ordinal);

        var result = _fixture.EditHandler.Set(_fixture.Plugin, _fixture.Cell.ToString(), "WaterHeight", Json("250.0"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace("\"WaterHeight\": 100.0", "\"WaterHeight\": 250.0", StringComparison.Ordinal),
            CellText());
    }

    [Fact]
    public void EditingACellsEditorId_LandsTheNewNameOnTheSameRecord()
    {
        var result = _fixture.EditHandler.Set(_fixture.Plugin, _fixture.Cell.ToString(), "EditorID", Json("\"RenamedCell\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal("RenamedCell", _fixture.Document(_fixture.Cell.ToString()).Require().EditorId);
        Assert.Contains("\"EditorID\": \"RenamedCell\"", CellText(), StringComparison.Ordinal);
    }

    private static System.Text.Json.JsonElement Json(string raw) =>
        System.Text.Json.JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingTheFormIdOfAPlainRecord_InAPluginHoldingACell_Succeeds()
    {
        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.Npc.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
    }
}
