using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Tests.Edits;

/// <summary>An unanswered external-change question refuses every gesture on the single write path
/// (ADR-0003), checked once ahead of anything the write would touch.</summary>
public sealed class EditRecordHandlerExternalChangeDeferralTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_Refuses_WhileAnExternalChangeQuestionIsUnansweredForItsMod()
    {
        _mod.RaiseExternalChange();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Contains("changed outside Modbench", result.Message, StringComparison.Ordinal);
        // The dialog's own two current actions.
        Assert.Contains("Commit to main as new baseline", result.Message, StringComparison.Ordinal);
        Assert.Contains("Apply to working tree on edit", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_Refuses_BeforeTouchingTheSourceFile()
    {
        var before = File.ReadAllText(_mod.NpcSourceFile);
        _mod.RaiseExternalChange();

        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(before, File.ReadAllText(_mod.NpcSourceFile));
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_Refuses_BeforeTheDocumentTheRepositoryServesChanges()
    {
        var beforeDocument = _mod.Document(_mod.Npc.ToString());
        Assert.NotNull(beforeDocument);
        var before = beforeDocument.Body;
        _mod.RaiseExternalChange();

        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var afterDocument = _mod.Document(_mod.Npc.ToString());
        Assert.NotNull(afterDocument);
        Assert.Equal(before, afterDocument.Body);
    }

    // The marker is a cache of the classifier's verdict, not the verdict: bytes restored by hand after
    // the question was raised leave nothing to ask, so the stale marker goes and the edit proceeds.
    [Fact]
    public void EditField_Proceeds_AndDropsTheStaleMarker_WhenTheBytesWereRestoredByHand()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);
        var original = File.ReadAllBytes(pluginPath);
        _mod.RaiseExternalChange();
        File.WriteAllBytes(pluginPath, original);

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Null(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
    }

    // A plugin caught mid-write gives no verdict: the marker stands and the edit stays refused, since
    // clearing on the plugins that could be read would let the write through while the question is live.
    [Fact]
    public void EditField_StaysRefused_AndKeepsTheMarker_WhileAPluginCannotBeRead()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);
        var original = File.ReadAllBytes(pluginPath);
        _mod.RaiseExternalChange();
        File.WriteAllBytes(pluginPath, original);
        using var held = new FileStream(pluginPath, FileMode.Open, FileAccess.Read, FileShare.None);

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.NotNull(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
    }

    [Fact]
    public void EditField_SucceedsAgain_OnceTheDeferralIsCleared()
    {
        _mod.RaiseExternalChange();
        SourceRepository.ClearExternalChangeQuestion(_mod.ModFolder);

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    // The rival this guards: scoping the marker per plugin again, which would let a second plugin's
    // own deferral leave this one editable — ADR-0003 makes the mod folder the one key.
    [Fact]
    public void EditField_InADifferentMod_IsUnaffectedByThatModsDeferral()
    {
        using var otherMod = SourceEditFixture.Tracked();
        otherMod.RaiseExternalChange();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }
}
