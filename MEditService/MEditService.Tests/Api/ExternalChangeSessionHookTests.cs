using MEditService.Api;
using MEditService.Bridge;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// #417 B11 / AC4: the load-time hash check. A binary changed while no watcher was ever running
/// (the "Modbench was closed" case) is still caught the moment a session loads, through the same
/// <see cref="MEditService.Core.Ledger.ExternalChangeClassifier"/> the live watcher itself calls.
/// </summary>
public sealed class ExternalChangeSessionHookTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void RunAfterLoad_QueuesAnExternalChange_ForABinaryThatChangedWithNoWatcherEverRunning()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        // Never watched before this call — exactly "closed" means: no FileSystemWatcher instance
        // has ever seen this write happen.
        var externalMod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = 0.9f;
        externalMod.Npcs.AddNew("UntouchedNpc");
        externalMod.WriteToBinary(pluginPath);

        var watcher = new ExternalChangeWatcher();
        ExternalChangeSessionHook.RunAfterLoad(_mod.Sessions.Session, watcher, NullLogger.Instance);

        var pending = Assert.Single(watcher.Pending());
        Assert.Equal(_mod.ModFolder, pending.ModFolder);
        Assert.Equal(TrackedModFixture.PluginName, pending.PluginName);
    }

    [Fact]
    public void RunAfterLoad_QueuesNothing_WhenTheBinaryNeverChanged()
    {
        var watcher = new ExternalChangeWatcher();

        ExternalChangeSessionHook.RunAfterLoad(_mod.Sessions.Session, watcher, NullLogger.Instance);

        Assert.Empty(watcher.Pending());
    }

    [Fact]
    public void RunAfterLoad_RegistersALiveWatch_SoFurtherChangesAreCaughtWithoutAnotherLoad()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));

        ExternalChangeSessionHook.RunAfterLoad(_mod.Sessions.Session, watcher, NullLogger.Instance);
        Assert.Empty(watcher.Pending());

        File.WriteAllBytes(pluginPath, "changed-live-after-load"u8.ToArray());

        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < deadline && watcher.Pending().Count == 0) Thread.Sleep(20);

        Assert.Single(watcher.Pending());
    }
}
