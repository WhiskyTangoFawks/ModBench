using System.Text.Json;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Edits;

/// <summary>An unanswered external-change question refuses every gesture on the single write path
/// (ADR-0041), checked once ahead of anything the write would touch.</summary>
public sealed class EditRecordHandlerExternalChangeDeferralTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_Refuses_WhileAnExternalChangeQuestionIsUnansweredForThePlugin()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, SourceEditFixture.PluginName,
            "Fixture.esp (in FixtureMod) changed outside Modbench.");

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Contains("changed outside Modbench", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_Refuses_BeforeTouchingTheSourceFile()
    {
        var before = File.ReadAllText(_mod.NpcSourceFile);
        ExternalChangeDeferral.Set(_mod.ModFolder, SourceEditFixture.PluginName, "unanswered");

        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(before, File.ReadAllText(_mod.NpcSourceFile));
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_Refuses_BeforeTheDocumentTheRepositoryServesChanges()
    {
        var before = _mod.Document(_mod.Npc.ToString())!.Body;
        ExternalChangeDeferral.Set(_mod.ModFolder, SourceEditFixture.PluginName, "unanswered");

        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(before, _mod.Document(_mod.Npc.ToString())!.Body);
    }

    [Fact]
    public void EditField_SucceedsAgain_OnceTheDeferralIsCleared()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, SourceEditFixture.PluginName, "unanswered");
        ExternalChangeDeferral.Clear(_mod.ModFolder, SourceEditFixture.PluginName);

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void EditField_OnADifferentPlugin_IsUnaffectedByAnotherPluginsDeferral()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "SomeOtherPlugin.esp", "unanswered");

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }
}
