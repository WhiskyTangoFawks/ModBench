using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class UntrackedReadOnlyTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingAPluginWithNoModFolder_IsRefused_NamingThePatchPluginPathInstead()
    {
        using var vanilla = SourceModFixture.VanillaMaster(out var vanillaNpc);

        var result = vanilla.EditHandler
            .Set(vanilla.Plugin, vanillaNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginHasNoModFolder, result.Refusal);
        Assert.Contains("patch", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EditingAPluginInOverwrite_IsRefused_NamingOverwriteAsAnOriginNotAMod()
    {
        using var overwrite = SourceModFixture.OverwriteStray(out var strayNpc);

        var result = overwrite.EditHandler
            .Set(overwrite.Plugin, strayNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginHasNoModFolder, result.Refusal);
        Assert.Contains("Overwrite", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("base-game", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("overwrite")]
    [InlineData("GhostMod")]
    public void EditingAPluginTheLoadOrderDoesNotName_IsRefusedAsNotInTheLoadOrder(string origin)
    {
        using var mod = SourceModFixture.VanillaMaster(out var npc);

        var result = mod.EditHandler.Set(new PluginAddress("Ghost.esp", origin), npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotInLoadOrder, result.Refusal);
    }

    [Fact]
    public void TheTwoRefusalsAreDistinct_AndNeitherMessageOffersTheOthersWayOut()
    {
        using var untracked = SourceEditFixture.Untracked();
        using var vanilla = SourceModFixture.VanillaMaster(out var vanillaNpc);

        var trackable = untracked.EditHandler
            .Set(untracked.Plugin, untracked.Npc.ToString(), "HeightMax", Json("0.75"));
        var notTrackable = vanilla.EditHandler
            .Set(vanilla.Plugin, vanillaNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.NotEqual(trackable.Refusal, notTrackable.Refusal);
        Assert.DoesNotContain("patch", trackable.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Track", notTrackable.Message, StringComparison.Ordinal);
        Assert.Contains("Track its mod", trackable.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TrackingTheSameModFolder_TurnsTheRefusalIntoAnAcceptedEdit()
    {
        using var mod = SourceEditFixture.Untracked();
        var tracked = await TrackEveryPluginOf.ModAsync(mod.LoadOrder, SourceEditFixture.ModFolderOrigin);
        Assert.Empty(tracked.RefusalMessages());

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.None, result.Refusal);
    }
}
