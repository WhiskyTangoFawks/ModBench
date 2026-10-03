using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class TopLevelFormLinkColumnEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_TopLevelFormLinkColumn_AcceptsAValidTarget_LandsAsWorkingTreeChange()
    {
        Assert.Empty(_mod.GitStatus());

        var result = Service().Set(_mod.Plugin, _mod.OtherNpc.ToString(), "Race", Json($"\"{_mod.Race}\""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());

        Assert.Contains(
            _mod.Race.ToString(), _mod.Document(_mod.OtherNpc.ToString()).Require().Body, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_TopLevelFormLinkColumn_LandsADanglingTarget()
    {
        var result = Service().Set(_mod.Plugin, _mod.OtherNpc.ToString(), "Race", Json("\"ABCDEF:NoSuchPlugin.esp\""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());
        Assert.Contains(
            "ABCDEF:NoSuchPlugin.esp", _mod.Document(_mod.OtherNpc.ToString()).Require().Body, StringComparison.Ordinal);
    }
}
