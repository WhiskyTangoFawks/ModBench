using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
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
    public async Task AFlagWhoseRangeThePluginExceeds_IsRefusedNamingWhy_WhileTheRestAreSet()
    {
        var fits = PluginHolding("Fits.esp", 0x800);
        var exceeds = PluginHolding("Exceeds.esp", 0x1000);
        var exceedsBefore = File.ReadAllBytes(exceeds);

        var result = await TestEditService.SetPluginFileFlagsHandler().Set([Small(exceeds), Small(fits)], GameRelease.Fallout4);

        Assert.Equal([fits], result.Applied.Select(set => set.Path));
        Assert.Equal([fits], result.Written);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((exceeds, PluginFileFlagRefusal.FormIdOutsideFlagLimit), (refused.Item, refused.Refusal));
        Assert.Contains("light range", refused.Message);
        Assert.Equal(exceedsBefore, File.ReadAllBytes(exceeds));
    }

    [Fact]
    public async Task SettingFlags_HandsTheRecordIndexToReadBackOnlyThePluginsTheLoadOrderHolds()
    {
        using var data = new PluginFixtureBuilder("set-plugin-file-flags-held").WithPlugin("Held.esp").Build();
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));
        var held = Assert.Single(data.Plugins);
        var index = HandedWrites.Create();

        var result = await TestEditService.SetPluginFileFlagsHandler(holder, index.Queries)
            .Set([Small(held.Path), Small(PluginHolding("Loose.esp", 0x800))], GameRelease.Fallout4);

        Assert.Equal(2, result.Applied.Count);
        Assert.Equal([HandedPlugin.ReadBack(held.Key)], Assert.Single(index.Hands).Require());
    }
}
