using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>An unanswered external-change question refuses every gesture on the single write path
/// (ADR-0041), checked once ahead of both the source write and the index write.</summary>
public sealed class RecordEditServiceExternalChangeDeferralTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_Refuses_WhileAnExternalChangeQuestionIsUnansweredForThePlugin()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName,
            "Fixture.esp (in FixtureMod) changed outside Modbench.");

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Contains("changed outside Modbench", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_Refuses_BeforeTouchingTheSourceFile()
    {
        var before = File.ReadAllText(_mod.NpcSourceFile);
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(before, File.ReadAllText(_mod.NpcSourceFile));
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_Refuses_BeforeTheIndexEverLearnsOfTheAttemptedChange()
    {
        var before = _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!
            .Fields.Single(f => f.Metadata.Name == "HeightMax").Value;
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var after = _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!
            .Fields.Single(f => f.Metadata.Name == "HeightMax").Value;
        Assert.Equal(before, after);
    }

    [Fact]
    public void EditField_SucceedsAgain_OnceTheDeferralIsCleared()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");
        ExternalChangeDeferral.Clear(_mod.ModFolder, TrackedModFixture.PluginName);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void EditField_OnADifferentPlugin_IsUnaffectedByAnotherPluginsDeferral()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "SomeOtherPlugin.esp", "unanswered");

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }
}
