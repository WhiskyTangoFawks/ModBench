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

    public static TheoryData<string, uint> GeneratedPluginsWithAStaleHeader => new()
    {
        { StaleHeaderPlugins.SettingsFileName, 5 },
        { StaleHeaderPlugins.LightFileName, 4 },
        { StaleHeaderPlugins.FullFileName, 11 },
    };

    [Theory]
    [MemberData(nameof(GeneratedPluginsWithAStaleHeader))]
    public async Task Save_OfAGeneratedPluginWithAStaleHeader_KeepsItsNextObjectId_AndDerivesNumRecordsFromContent(
        string fileName, uint derivedNumRecords)
    {
        using var folder = new ScratchDirectory("pw-save-stale-header");
        var stale = StaleHeaderPlugins.Named(fileName);
        stale.WriteInto(folder);
        var pluginPath = Path.Combine(folder, fileName);
        Assert.Equal((stale.StoredNextObjectId, stale.StoredNumRecords), HeaderStatsOf(pluginPath));

        await RewriteAsync(pluginPath);

        Assert.Equal((stale.StoredNextObjectId, derivedNumRecords), HeaderStatsOf(pluginPath));
    }

    private static (uint NextObjectId, uint NumRecords) HeaderStatsOf(string pluginPath)
    {
        using var plugin = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(Path.GetFileName(pluginPath)), pluginPath), Fallout4Release.Fallout4);
        return (plugin.ModHeader.Stats.NextFormID, plugin.ModHeader.Stats.NumRecords);
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
    public async Task ASave_RemovesALeftoverOfAWriterThatIsGone()
    {
        using var data = new PluginFixtureBuilder("pw-save-leftover")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var leftover = TempLeftover.DeadWriters(data.DataFolder);

        await RewriteAsync(Path.Combine(data.DataFolder, "TestPlugin.esp"));

        Assert.False(File.Exists(leftover));
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
            new RegisteredPlugin("Fixture.esp", "FixtureMod", pluginPath, new PluginProvider.FromMod("FixtureMod", folder, folder), Line: null, HandedStrings.Of(pluginPath)),
            EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();
        var tree = (await adapter.ReadTreeAsync(source.Files, EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        var saved = await tree.SaveAsync(pluginPath, ["Other.esm", "Fixture.esp"], ["Master.esm", "Other.esm"], save =>
        {
            save.Commit();
            return true;
        });

        Assert.False(saved.Holds(out _, out var failure));
        Assert.Equal("it references Master.esm, which the load order does not hold", Assert.IsType<PluginFailure.MasterNotInLoadOrder>(failure).Reason);
        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }

    [Fact]
    public async Task Save_OfAStarfieldOverrideOfALightMastersRecord_WritesItUnderThatMastersFormKey_AndDropsNothing()
    {
        using var scratch = new ScratchDirectory("pw-save-light-master");
        var loadOrder = LightMasterAndChild.LoadOrderIn(scratch);
        var child = LightMasterAndChild.ChildIn(loadOrder);
        var adapter = TestAdapters.Mutagen();
        var source = (await adapter.ReadSourceOfAsync(child, loadOrder)).Answered();
        var tree = (await adapter.ReadTreeAsync(source.Files, loadOrder)).Answered();

        var drops = (await tree.SaveAsync(child.Path, source.Masters, source.Masters, save =>
        {
            var dropped = tree.DropsIn(save);
            save.Commit();
            return dropped;
        })).Answered();

        Assert.Empty(drops);
        using var written = adapter.OpenDocuments(
            new ModPath(LightMasterAndChild.Child, child.Path), loadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield), PluginStrings.None).Answered();
        Assert.Equal([LightMasterAndChild.Weapon.ToString()], written.Records.Select(record => record.FormKey));
    }

    [Fact]
    public async Task Save_OfAStarfieldTree_WhoseMasterHeaderDoesNotRead_Fails_AndLeavesTheBinary()
    {
        using var scratch = new ScratchDirectory("pw-save-unreadable-master");
        var loadOrder = LightMasterAndChild.LoadOrderIn(scratch);
        var child = LightMasterAndChild.ChildIn(loadOrder);
        var adapter = TestAdapters.Mutagen();
        var source = (await adapter.ReadSourceOfAsync(child, loadOrder)).Answered();
        var tree = (await adapter.ReadTreeAsync(source.Files, loadOrder)).Answered();
        File.WriteAllBytes(Path.Combine(scratch, LightMasterAndChild.Master.FileName), "not a plugin"u8.ToArray());
        var before = File.ReadAllBytes(child.Path);

        var saved = await tree.SaveAsync(child.Path, source.Masters, source.Masters, save =>
        {
            save.Commit();
            return true;
        });

        Assert.Equal(LightMasterAndChild.Master.FileName, Assert.IsType<PluginFailure.MasterUnreadable>(saved.Failure()).Master);
        Assert.Equal(before, File.ReadAllBytes(child.Path));
    }

    [Fact]
    public async Task TheDropCheck_OfAStarfieldSave_WhoseMasterTurnsUnreadableAfterTheWrite_ReadsTheStylesTheWriteUsed()
    {
        using var scratch = new ScratchDirectory("pw-save-master-turns-unreadable");
        var loadOrder = LightMasterAndChild.LoadOrderIn(scratch);
        var child = LightMasterAndChild.ChildIn(loadOrder);
        var adapter = TestAdapters.Mutagen();
        var source = (await adapter.ReadSourceOfAsync(child, loadOrder)).Answered();
        var tree = (await adapter.ReadTreeAsync(source.Files, loadOrder)).Answered();

        var drops = (await tree.SaveAsync(child.Path, source.Masters, source.Masters, save =>
        {
            File.WriteAllBytes(Path.Combine(scratch, LightMasterAndChild.Master.FileName), "not a plugin"u8.ToArray());
            return tree.DropsIn(save);
        })).Answered();

        Assert.Empty(drops);
    }
}
