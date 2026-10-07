using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class OverriddenAndUnlistedRefusalTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingAnOverriddenPlugin_IsRefused_NamingThePluginItsOriginAndThatTheGameDoesNotLoadIt()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.Set(mod.OverriddenPlugin, mod.OverriddenNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotActive, result.Refusal);
        Assert.Contains(OverriddenAndUnlistedFixture.PluginName, result.Message, StringComparison.Ordinal);
        Assert.Contains(OverriddenAndUnlistedFixture.OverriddenOrigin, result.Message, StringComparison.Ordinal);
        Assert.Contains("does not load", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EditingTheWinningPlugin_OfTheSameName_Lands()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.Set(mod.WinningPlugin, mod.WinningNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void ElementOpsOnAnOverriddenPlugin_AreRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var npc = mod.OverriddenNpc.ToString();

        var add = mod.EditHandler.Edit(mod.OverriddenPlugin, npc, AddAt(Member("Keywords")));
        var remove = mod.EditHandler.Edit(mod.OverriddenPlugin, npc, RemoveAt(Member("Keywords"), At(0)));
        var move = mod.EditHandler.Edit(mod.OverriddenPlugin, npc, MoveTo(0, Member("Keywords"), At(1)));

        Assert.Equal(RecordEditRefusal.PluginNotActive, add.Refusal);
        Assert.Equal(RecordEditRefusal.PluginNotActive, remove.Refusal);
        Assert.Equal(RecordEditRefusal.PluginNotActive, move.Refusal);
    }

    [Fact]
    public void EditingAPluginWithNoLine_IsRefusedAsNotActive_AndAnswersNoChanges()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.Set(mod.UnlistedPlugin, mod.UnlistedNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(RecordEditRefusal.PluginNotActive, result.Refusal);
        Assert.Empty(mod.ChangedFormKeys(mod.UnlistedPlugin));
    }

    [Fact]
    public void EditingATrackedPluginWhoseLineIsDisabled_IsRefusedAsNotActive_AndAnswersNoChanges()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(mod.GameDirectory, mod.GameDirectory, GameRelease.Fallout4,
            mod.Entries.Select(e => e.Key == mod.WinningPlugin ? e with { Enabled = false } : e)));

        var result = TestEditService.EditHandler(holder)
            .Set(mod.WinningPlugin, mod.WinningNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.Equal(RecordEditRefusal.PluginNotActive, result.Refusal);
        Assert.Empty(mod.ChangedFormKeys(mod.WinningPlugin));
    }

    [Fact]
    public void CreatingARecord_InAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CreateHandler.CreateRecord(mod.OverriddenPlugin, "npc_");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotActive, result.Refusal);
    }

    [Fact]
    public void DeletingARecord_InAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.DeleteHandler.DeleteRecordsSync(
            [new RecordAt(mod.OverriddenPlugin, mod.OverriddenNpc.ToString())]);

        Assert.Empty(result.Landed);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.PluginNotActive, refusal.Refusal);
        Assert.NotNull(mod.Document(mod.OverriddenPlugin, mod.OverriddenNpc.ToString()));
    }

    [Fact]
    public void EditingTheFormId_OfARecordInAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.SetFormId(
            mod.OverriddenPlugin, mod.OverriddenNpc.ToString(), $"000F00:{mod.OverriddenPlugin.Name}");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotActive, result.Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.Override, [mod.OverriddenPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.PluginNotActive, refused.Refusal);
    }

    [Fact]
    public void CopyingAsNewRecord_IntoAnOverriddenPlugin_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.New, [mod.OverriddenPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.PluginNotActive, refused.Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoTheWinningPlugin_Lands()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.Override, [mod.WinningPlugin], replace: false);

        result.OnlyLanded();
        Assert.NotNull(mod.Document(mod.WinningPlugin, mod.CopySourceNpc.ToString()));
    }

    [Fact]
    public void CopyingFromAnOverriddenPlugin_IntoAWinningPlugin_IsAllowed()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.OverriddenPlugin, mod.OverriddenNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.NotNull(mod.Document(mod.DestinationPlugin, mod.OverriddenNpc.ToString()));
    }

    [Fact]
    public void ElementOpsOnAPluginWithNoLine_AreRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var npc = mod.UnlistedNpc.ToString();

        var add = mod.EditHandler.Edit(mod.UnlistedPlugin, npc, AddAt(Member("Keywords")));
        var remove = mod.EditHandler.Edit(mod.UnlistedPlugin, npc, RemoveAt(Member("Keywords"), At(0)));
        var move = mod.EditHandler.Edit(mod.UnlistedPlugin, npc, MoveTo(0, Member("Keywords"), At(1)));

        Assert.Equal(RecordEditRefusal.PluginNotActive, add.Refusal);
        Assert.Equal(RecordEditRefusal.PluginNotActive, remove.Refusal);
        Assert.Equal(RecordEditRefusal.PluginNotActive, move.Refusal);
    }

    [Fact]
    public void CreatingARecord_InAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CreateHandler.CreateRecord(mod.UnlistedPlugin, "npc_");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotActive, result.Refusal);
    }

    [Fact]
    public void DeletingARecord_InAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.DeleteHandler.DeleteRecordsSync(
            [new RecordAt(mod.UnlistedPlugin, mod.UnlistedNpc.ToString())]);

        Assert.Empty(result.Landed);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.PluginNotActive, refusal.Refusal);
        Assert.NotNull(mod.Document(mod.UnlistedPlugin, mod.UnlistedNpc.ToString()));
    }

    [Fact]
    public void EditingTheFormId_OfARecordInAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.EditHandler.SetFormId(
            mod.UnlistedPlugin, mod.UnlistedNpc.ToString(), $"000F00:{mod.UnlistedPlugin.Name}");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotActive, result.Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.Override, [mod.UnlistedPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.PluginNotActive, refused.Refusal);
    }

    [Fact]
    public void CopyingAsNewRecord_IntoAPluginWithNoLine_IsRefused()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.New, [mod.UnlistedPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.PluginNotActive, refused.Refusal);
    }
}
