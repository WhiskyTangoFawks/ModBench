using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// An unanswered external-change question refuses every gesture on the single
/// write path (ADR-0041) — checked once, ahead of both doors that path has: the source file
/// write, and <c>index.ApplyWorkingTreeChanges</c> telling the DB. New edit gestures
/// through <see cref="RecordEditService"/> must inherit this refusal without adding their
/// own check.
/// </summary>
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

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Contains("changed outside Modbench", result.Message, StringComparison.Ordinal);
    }

    /// <summary>The write path's <b>first</b> door: refusing must happen before the source file is
    /// touched at all — the same "no half-applied state" invariant every other refusal in this class
    /// already holds.</summary>
    [Fact]
    public void EditField_Refuses_BeforeTouchingTheSourceFile()
    {
        var before = File.ReadAllText(_mod.NpcSourceFile);
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.Equal(before, File.ReadAllText(_mod.NpcSourceFile));
        Assert.Empty(_mod.GitStatus());
    }

    /// <summary>The write path's <b>second</b> door: refusing must happen before
    /// <c>index.ApplyWorkingTreeChanges</c> is ever reached, so the DB-backed read model
    /// (<see cref="RecordRef.Effective"/>) never advances past the last accepted state either — not
    /// just the file on disk.</summary>
    [Fact]
    public void EditField_Refuses_BeforeTheIndexEverLearnsOfTheAttemptedChange()
    {
        var before = _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!
            .Fields.Single(f => f.Metadata.Name == "height_max").Value;
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        var after = _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!
            .Fields.Single(f => f.Metadata.Name == "height_max").Value;
        Assert.Equal(before, after);
    }

    [Fact]
    public void EditField_SucceedsAgain_OnceTheDeferralIsCleared()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");
        ExternalChangeDeferral.Clear(_mod.ModFolder, TrackedModFixture.PluginName);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void EditField_OnADifferentPlugin_IsUnaffectedByAnotherPluginsDeferral()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "SomeOtherPlugin.esp", "unanswered");

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }
}
