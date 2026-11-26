using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class NotActivePluginEditTests
{
    private static (PluginAddress Plugin, string Npc) Overridden(OverriddenAndUnlistedFixture mod) =>
        (mod.OverriddenPlugin, mod.OverriddenNpc.ToString());

    private static (PluginAddress Plugin, string Npc) Unlisted(OverriddenAndUnlistedFixture mod) =>
        (mod.UnlistedPlugin, mod.UnlistedNpc.ToString());

    private static (PluginAddress Plugin, string Npc) DisablingTheWinner(OverriddenAndUnlistedFixture mod)
    {
        mod.Relist(mod.WinningPlugin, entry => entry with { Enabled = false });
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

    [Fact]
    public void CopyingAsOverride_IntoTheOverriddenCopyOfAFileName_LandsInThatCopy()
    {
        using var mod = OverriddenAndUnlistedFixture.Create();

        var result = mod.CopyHandler.CopySync(
            [new RecordAt(mod.CopySourcePlugin, mod.CopySourceNpc.ToString())], CopyMode.Override, [mod.OverriddenPlugin], replace: false);

        result.OnlyLanded();
        Assert.NotNull(mod.Document(mod.OverriddenPlugin, mod.CopySourceNpc.ToString()));
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
