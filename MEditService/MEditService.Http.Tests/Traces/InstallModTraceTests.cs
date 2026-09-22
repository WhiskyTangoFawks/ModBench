using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Traces;

/// <summary>install-mod: the install renames a folder into mods/ and forgets it. Nothing on the
/// mEdit side watches mods/, so the folder arrives as the next snapshot: the tail is enable-a-mod's.</summary>
[Collection(WebHostCollection.Name)]
public sealed class InstallModTraceTests : HostedTests
{
    private const string Installed = "Installed.esp";
    private const string InstalledMod = "InstalledMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-install-a-mod")
        .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("BaseNpc"), origin: "BaseMod")
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    // The staged folder renamed into mods/, as the install writes it: a folder with a plugin in it,
    // appearing while the service is up.
    private LoadOrderEntry InstallTheFolder()
    {
        var folder = Path.Combine(_instance.Root, "mod-installed");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, Installed);
        var mod = new Fallout4Mod(ModKey.FromFileName(Installed), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("InstalledNpc");
        mod.WriteToBinary(path);
        return new LoadOrderEntry(Installed, path, InstalledMod, Slot: 1, Enabled: true, Winning: true);
    }

    [Fact]
    public async Task AModInstalledWhileTheServiceIsUp_IsIndexedAndAnswersOnTheNextSnapshot()
    {
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

        var installed = InstallTheFolder();
        var adopted = await Client.PutLoadOrder(_instance, [.. _instance.Plugins, installed]);

        adopted.EnsureSuccessStatusCode();
        var plugin = await Client.Plugin(Installed);
        Assert.Equal(InstalledMod, plugin.GetProperty("origin").GetString());
        Assert.Equal(1, plugin.GetProperty("loadOrderIndex").GetInt32());
        var record = await Client.Record(await Client.FirstFormKey(Installed));
        Assert.Equal("InstalledNpc", record.GetProperty("editorId").GetString());
    }
}
