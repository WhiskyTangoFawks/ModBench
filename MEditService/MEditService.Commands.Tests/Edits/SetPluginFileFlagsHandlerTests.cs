using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class SetPluginFileFlagsHandlerTests : IDisposable
{
    private readonly ScratchDirectory _scratch = new("set-plugin-file-flags-");

    public void Dispose() => _scratch.Dispose();

    private string PluginHolding(string fileName, uint id)
    {
        var path = Path.Combine(_scratch, fileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(fileName), Fallout4Release.Fallout4);
        mod.Npcs.Add(new Npc(new FormKey(mod.ModKey, id), Fallout4Release.Fallout4));
        mod.WriteToBinary(path);
        return path;
    }

    private static PluginFileFlagsToSet Small(string path) => new(path, new Dictionary<string, bool> { ["Small"] = true });

    [Fact]
    public void AFlagWhoseRangeThePluginExceeds_IsRefusedNamingWhy_WhileTheRestAreSet()
    {
        var fits = PluginHolding("Fits.esp", 0x800);
        var exceeds = PluginHolding("Exceeds.esp", 0x1000);
        var exceedsBefore = File.ReadAllBytes(exceeds);

        var result = TestEditService.SetPluginFileFlagsHandler().Set([Small(exceeds), Small(fits)], GameRelease.Fallout4);

        Assert.Equal([fits], result.Applied.Select(set => set.Path));
        var refused = Assert.Single(result.Refused);
        Assert.Equal((exceeds, PluginFileFlagRefusal.FormIdOutsideFlagLimit), (refused.Item, refused.Refusal));
        Assert.Contains("light range", refused.Message);
        Assert.Equal(exceedsBefore, File.ReadAllBytes(exceeds));
    }
}
