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
        ExternalChangeDeferral.Set(_mod.ModFolder, "Fixture.esp (in FixtureMod) changed outside Modbench.");

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Contains("changed outside Modbench", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_Refuses_BeforeTouchingTheSourceFile()
    {
        var before = File.ReadAllText(_mod.NpcSourceFile);
        ExternalChangeDeferral.Set(_mod.ModFolder, "unanswered");

        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(before, File.ReadAllText(_mod.NpcSourceFile));
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_Refuses_BeforeTheDocumentTheRepositoryServesChanges()
    {
        var before = _mod.Document(_mod.Npc.ToString())!.Body;
        ExternalChangeDeferral.Set(_mod.ModFolder, "unanswered");

        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(before, _mod.Document(_mod.Npc.ToString())!.Body);
    }

    [Fact]
    public void EditField_SucceedsAgain_OnceTheDeferralIsCleared()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "unanswered");
        ExternalChangeDeferral.Clear(_mod.ModFolder);

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    // The rival this guards: scoping the marker per plugin again, which would let a second plugin's
    // own deferral leave this one editable — ADR-0041 amendment makes the mod folder the one key.
    [Fact]
    public void EditField_InADifferentMod_IsUnaffectedByThatModsDeferral()
    {
        using var otherMod = SourceEditFixture.Tracked();
        ExternalChangeDeferral.Set(otherMod.ModFolder, "unanswered");

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }
}
