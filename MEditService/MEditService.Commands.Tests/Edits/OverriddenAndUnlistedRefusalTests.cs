using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A plugin the game does not load, overridden or with no plugins.txt line, is read-only
/// (ADR-0012 invariant 5), refused before any source write. The same write against the winning
/// plugin of the same name lands.</summary>
public sealed class OverriddenAndUnlistedRefusalTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingAnOverriddenPlugin_IsRefused_NamingThePluginItsOriginAndThatTheGameDoesNotLoadIt()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.Set(mod.OverriddenPlugin, mod.OverriddenNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, result.Refusal);
        Assert.Contains(OverriddenAndUnlistedFixture.PluginName, result.Message, StringComparison.Ordinal);
        Assert.Contains(OverriddenAndUnlistedFixture.OverriddenOrigin, result.Message, StringComparison.Ordinal);
        Assert.Contains("does not load", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EditingAnOverriddenPlugin_WritesNothing()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        mod.EditHandler.Set(mod.OverriddenPlugin, mod.OverriddenNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.Empty(mod.GitStatus(mod.OverriddenPlugin));
        var document = mod.Document(mod.OverriddenPlugin, mod.OverriddenNpc.ToString());
        Assert.NotNull(document);
        Assert.Equal(OverriddenAndUnlistedFixture.OverriddenNpcEditorId, document.EditorId);
    }

    [Fact]
    public void EditingTheWinningPlugin_OfTheSameName_Lands()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.Set(mod.WinningPlugin, mod.WinningNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void ElementOpsOnAnOverriddenPlugin_AreRefused_ThroughEditRecordHandler()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var npc = mod.OverriddenNpc.ToString();

        var add = mod.EditHandler.Edit(mod.OverriddenPlugin, npc, AddAt(Member("Keywords")));
        var remove = mod.EditHandler.Edit(mod.OverriddenPlugin, npc, RemoveAt(Member("Keywords"), At(0)));
        var move = mod.EditHandler.Edit(mod.OverriddenPlugin, npc, MoveTo(0, Member("Keywords"), At(1)));

        Assert.Equal(RecordEditRefusal.OverriddenPlugin, add.Refusal);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, remove.Refusal);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, move.Refusal);
    }

    [Fact]
    public void EditingAWinningPluginWithNoLine_IsRefusedAsUnlisted_NotAsOverridden_WritingNothing()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.Set(mod.UnlistedPlugin, mod.UnlistedNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(RecordEditRefusal.UnlistedPlugin, result.Refusal);
        Assert.Empty(mod.GitStatus(mod.UnlistedPlugin));
    }

    [Fact]
    public async Task CompilingAnOverriddenPlugin_WithAnOpenQuestion_IsRefusedAsExternalChangeUnanswered_WritingNothing()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        mod.RaiseExternalChangeOn(mod.OverriddenPlugin, "unanswered");
        var before = mod.PluginBytes(mod.OverriddenPlugin);

        var result = await mod.CompileHandler.CompileAsync(mod.OverriddenPlugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Equal(before, mod.PluginBytes(mod.OverriddenPlugin));
    }

    [Fact]
    public void CreatingARecord_InAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CreateHandler.CreateRecord(mod.OverriddenPlugin, "npc_", "NewNpc");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, result.Refusal);
    }

    [Fact]
    public void DeletingARecord_InAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.DeleteHandler.DeleteRecords(
            [new RecordAt(mod.OverriddenPlugin, mod.OverriddenNpc.ToString())]);

        Assert.Empty(result.Applied);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, refusal.Refusal);
        Assert.NotNull(mod.Document(mod.OverriddenPlugin, mod.OverriddenNpc.ToString()));
    }

    [Fact]
    public void RenumberingARecord_InAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.RenumberHandler.RenumberRecord(mod.OverriddenPlugin, mod.OverriddenNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, result.Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.OverriddenPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, result.Refusal);
    }

    [Fact]
    public void CopyingAsNewRecord_IntoAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.OverriddenPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.OverriddenPlugin, result.Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoTheWinningPlugin_Lands()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.WinningPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(mod.Document(mod.WinningPlugin, mod.CopySourceNpc.ToString()));
    }

    [Fact]
    public void CopyingFromAnOverriddenPlugin_IntoAWinningPlugin_IsAllowed()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(
            mod.OverriddenPlugin, mod.OverriddenNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(mod.Document(mod.DestinationPlugin, mod.OverriddenNpc.ToString()));
    }

    [Fact]
    public void ElementOpsOnAPluginWithNoLine_AreRefused_ThroughEditRecordHandler()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var npc = mod.UnlistedNpc.ToString();

        var add = mod.EditHandler.Edit(mod.UnlistedPlugin, npc, AddAt(Member("Keywords")));
        var remove = mod.EditHandler.Edit(mod.UnlistedPlugin, npc, RemoveAt(Member("Keywords"), At(0)));
        var move = mod.EditHandler.Edit(mod.UnlistedPlugin, npc, MoveTo(0, Member("Keywords"), At(1)));

        Assert.Equal(RecordEditRefusal.UnlistedPlugin, add.Refusal);
        Assert.Equal(RecordEditRefusal.UnlistedPlugin, remove.Refusal);
        Assert.Equal(RecordEditRefusal.UnlistedPlugin, move.Refusal);
    }

    [Fact]
    public void CreatingARecord_InAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CreateHandler.CreateRecord(mod.UnlistedPlugin, "npc_", "NewNpc");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UnlistedPlugin, result.Refusal);
    }

    [Fact]
    public void DeletingARecord_InAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.DeleteHandler.DeleteRecords(
            [new RecordAt(mod.UnlistedPlugin, mod.UnlistedNpc.ToString())]);

        Assert.Empty(result.Applied);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.UnlistedPlugin, refusal.Refusal);
        Assert.NotNull(mod.Document(mod.UnlistedPlugin, mod.UnlistedNpc.ToString()));
    }

    [Fact]
    public void RenumberingARecord_InAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.RenumberHandler.RenumberRecord(mod.UnlistedPlugin, mod.UnlistedNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UnlistedPlugin, result.Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.UnlistedPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UnlistedPlugin, result.Refusal);
    }

    [Fact]
    public void CopyingAsNewRecord_IntoAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.UnlistedPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UnlistedPlugin, result.Refusal);
    }

    [Fact]
    public void EditingAnOverriddenPlugin_WithAnOpenQuestion_IsRefusedAsExternalChangeUnanswered()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        mod.RaiseExternalChangeOn(mod.OverriddenPlugin, "unanswered");

        var result = mod.EditHandler.Set(mod.OverriddenPlugin, mod.OverriddenNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
    }

    [Fact]
    public void EditingAPluginWithNoLine_WithAnOpenQuestion_IsRefusedAsExternalChangeUnanswered()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        mod.RaiseExternalChangeOn(mod.UnlistedPlugin, "unanswered");

        var result = mod.EditHandler.Set(mod.UnlistedPlugin, mod.UnlistedNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
    }
}
