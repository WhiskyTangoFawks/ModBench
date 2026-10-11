using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.Changes;

public sealed class PluginWriterSaveTests
{
    private static async Task RewriteAsync(string pluginPath)
    {
        await TreeSaves.SaveAsync(pluginPath, prep =>
        {
            prep.Commit();
            return true;
        });
    }

    [Fact]
    public async Task Commit_OriginalPathHoldsValidPlugin()
    {
        using var data = new PluginFixtureBuilder("pw-save-original")
            .WithPlugin("TestPlugin.esp")
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        await RewriteAsync(pluginPath);

        var reloaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("TestPlugin.esp"), pluginPath), Fallout4Release.Fallout4);
        Assert.Equal("TestPlugin.esp", reloaded.ModKey.FileName);
    }

    [Fact]
    public async Task Commit_LeavesTheDataFolderHoldingTheSameFiles()
    {
        using var data = new PluginFixtureBuilder("pw-save-no-tmpdir")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var before = FolderEntries.Of(data.DataFolder);

        await RewriteAsync(Path.Combine(data.DataFolder, "TestPlugin.esp"));

        Assert.Equal(before, FolderEntries.Of(data.DataFolder));
    }

    [Fact]
    public async Task Commit_ThatCannotMoveTheNewBinaryIn_LeavesTheOldOne()
    {
        using var data = new PluginFixtureBuilder("pw-commit-keeps-old")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var before = File.ReadAllBytes(pluginPath);

        var entriesBefore = FolderEntries.Of(data.DataFolder);

        await TreeSaves.SaveAsync(pluginPath, prep =>
        {
            var added = FolderEntries.TheOneAddedTo(data.DataFolder, entriesBefore);
            File.Delete(Path.Combine(added, "TestPlugin.esp"));

            return Assert.ThrowsAny<IOException>(prep.Commit);
        });

        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }

    [Fact]
    public async Task Save_WhoseLoadOrderLacksAMasterTheTreeReferences_FailsNamingIt_AndLeavesTheBinary()
    {
        using var folder = new ScratchDirectory("pw-save-master-not-in-load-order");
        var pluginPath = Path.Combine(folder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("Npc");
        npc.Race.SetTo(new FormKey(ModKey.FromFileName("Master.esm"), 0x800));
        npc.Class.SetTo(new FormKey(ModKey.FromFileName("Other.esm"), 0x800));
        mod.WriteToBinary(pluginPath);
        var before = File.ReadAllBytes(pluginPath);
        var adapter = TestAdapters.Mutagen();
        var source = (await adapter.ReadSourceOfAsync(
            new RegisteredPlugin("Fixture.esp", "FixtureMod", pluginPath, new PluginProvider.FromMod("FixtureMod", folder), Line: null),
            EmptyLoadOrder.Of(GameRelease.Fallout4), new PluginStrings(folder, folder))).Answered();
        var tree = (await adapter.ReadTreeAsync(source.Files, GameRelease.Fallout4)).Answered();

        var saved = await tree.SaveAsync(pluginPath, ["Other.esm", "Fixture.esp"], save =>
        {
            save.Commit();
            return true;
        });

        Assert.False(saved.Holds(out _, out var failure));
        Assert.Equal("it references Master.esm, which the load order does not hold", Assert.IsType<PluginFailure.MasterNotInLoadOrder>(failure).Reason);
        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
