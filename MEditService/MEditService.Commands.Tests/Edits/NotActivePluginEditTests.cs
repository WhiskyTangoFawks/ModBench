using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class NotActivePluginEditTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static void Disable(OverriddenAndUnlistedFixture mod, PluginAddress plugin) =>
        mod.Relist(plugin, entry => entry with { Enabled = false });

    private static (PluginAddress Plugin, string Npc) Overridden(OverriddenAndUnlistedFixture mod) =>
        (mod.OverriddenPlugin, mod.OverriddenNpc.ToString());

    private static (PluginAddress Plugin, string Npc) Unlisted(OverriddenAndUnlistedFixture mod) =>
        (mod.UnlistedPlugin, mod.UnlistedNpc.ToString());

    private static (PluginAddress Plugin, string Npc) DisablingTheWinner(OverriddenAndUnlistedFixture mod)
    {
        Disable(mod, mod.WinningPlugin);
        return (mod.WinningPlugin, mod.WinningNpc.ToString());
    }

    private static readonly Dictionary<string, Func<OverriddenAndUnlistedFixture, (PluginAddress Plugin, string Npc)>> NotActivePlugin = new()
    {
        ["overridden"] = Overridden,
        ["unlisted"] = Unlisted,
        ["disabled"] = DisablingTheWinner,
    };

    public static TheoryData<string> NotActive => [.. NotActivePlugin.Keys];

    [Theory]
    [MemberData(nameof(NotActive))]
    public void EditingAFieldOfAPluginThatIsNotActive_Lands(string which)
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var (plugin, npc) = NotActivePlugin[which](mod);

        var result = mod.EditHandler.Set(plugin, npc, "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal([npc], mod.ChangedFormKeys(plugin));
    }

    [Theory]
    [MemberData(nameof(NotActive))]
    public void AddingAnElement_ToARecordOfAPluginThatIsNotActive_Lands(string which)
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var (plugin, npc) = NotActivePlugin[which](mod);

        var result = mod.EditHandler.Edit(plugin, npc, AddAt(Member("Keywords")));

        Assert.True(result.Applied, result.Message);
    }

    [Theory]
    [MemberData(nameof(NotActive))]
    public void ChangingTheFormIdOfARecordOfAPluginThatIsNotActive_Lands(string which)
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var (plugin, npc) = NotActivePlugin[which](mod);

        var result = mod.EditHandler.SetFormId(plugin, npc, $"000F00:{plugin.Name}");

        Assert.True(result.Applied, result.Message);
    }

    [Theory]
    [MemberData(nameof(NotActive))]
    public void CreatingARecord_InAPluginThatIsNotActive_Lands(string which)
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var (plugin, _) = NotActivePlugin[which](mod);

        var result = mod.CreateHandler.CreateRecordSync(plugin, "npc_");

        Assert.True(result.Applied, result.Message);
    }

    [Theory]
    [MemberData(nameof(NotActive))]
    public void DeletingARecord_InAPluginThatIsNotActive_Lands(string which)
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var (plugin, npc) = NotActivePlugin[which](mod);

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(plugin, npc)]);

        Assert.Single(result.Landed);
        Assert.Null(mod.Document(plugin, npc));
    }

    [Theory]
    [MemberData(nameof(NotActive))]
    public void CopyingAsNewRecord_IntoAPluginThatIsNotActive_Lands(string which)
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var (plugin, _) = NotActivePlugin[which](mod);

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.New, [plugin], replace: false);

        result.OnlyLanded();
    }

    [Theory]
    [MemberData(nameof(NotActive))]
    public void CopyingAsOverride_IntoAPluginThatIsNotActive_WhoseLineIsAfterTheOrigin_OrThatHasNone_Lands(string which)
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        var (plugin, _) = NotActivePlugin[which](mod);

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.Override, [plugin], replace: false);

        result.OnlyLanded();
        Assert.NotNull(mod.Document(plugin, mod.CopySourceNpc.ToString()));
    }

    [Fact]
    public void CopyingAsOverride_IntoADisabledPluginWhoseLineIsBeforeTheOrigin_IsRefusedAsAnUnderride()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        Disable(mod, mod.CopySourcePlugin);

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.WinningPlugin, mod.WinningNpc.ToString())], CopyMode.Override, [mod.CopySourcePlugin], replace: false);

        Assert.Equal(RecordEditRefusal.UnderrideDestination, result.OnlyRefused().Refusal);
        Assert.Null(mod.Document(mod.CopySourcePlugin, mod.WinningNpc.ToString()));
    }

    [Fact]
    public void CopyingAsOverride_IntoAPluginWhoseLineIsBeforeADisabledOrigin_IsRefusedAsAnUnderride()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();
        Disable(mod, mod.WinningPlugin);

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.WinningPlugin, mod.WinningNpc.ToString())], CopyMode.Override, [mod.CopySourcePlugin], replace: false);

        Assert.Equal(RecordEditRefusal.UnderrideDestination, result.OnlyRefused().Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoThePluginItsLineOverrides_IsNoUnderride()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.WinningPlugin, mod.WinningNpc.ToString())], CopyMode.Override, [mod.OverriddenPlugin], replace: true);

        result.OnlyLanded();
    }

    [Fact]
    public void CopyingFromAnOverriddenPlugin_IntoAWinningPlugin_Lands()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.OverriddenPlugin, mod.OverriddenNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.NotNull(mod.Document(mod.DestinationPlugin, mod.OverriddenNpc.ToString()));
    }
}
