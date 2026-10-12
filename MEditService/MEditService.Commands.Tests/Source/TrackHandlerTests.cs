using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Source;

public sealed class TrackHandlerTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScratchDirectory _instanceRoot = new("medit-track-handler-");
    private readonly LoadOrderHolder _holder = new();
    private readonly PluginProvider.FromMod _mod;

    public TrackHandlerTests()
    {
        _mod = new PluginProvider.FromMod(
            Origin,
            Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName,
            Path.Combine(_instanceRoot, "source", Origin));
        var gameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;

        var pluginPath = Path.Combine(_mod.Folder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FixtureNpc");
        mod.WriteToBinary(pluginPath);

        Snapshot = SnapshotPlugins.Snapshot(gameDirectory, _instanceRoot, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, pluginPath, Origin, 0, Enabled: true, Winning: true, NamedProvider: _mod)]);
    }

    private LoadOrderSnapshot Snapshot { get; }

    public void Dispose() => _instanceRoot.Dispose();

    [Fact]
    public async Task Track_OverTheHeldLoadOrder_TracksThePluginIntoItsSourceFolder_AndWritesNothingInItsModFolder()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.TrackHandler(_holder);
        var modFolderBefore = TreeSnapshot.Of(_mod.Folder);

        var result = await handler.TrackAsync([Origin]);

        Assert.Equal([new PluginAddress(PluginName, Origin)], Assert.Single(result.Landed).Outcome.Tracked);
        Assert.True(TestAdapters.Source().SourceReads(new RegisteredPlugin(PluginName, Origin, "", _mod, Line: null)));
        Assert.Equal(modFolderBefore, TreeSnapshot.Of(_mod.Folder));
    }

    [Fact]
    public async Task Track_OverAModTwiceUnderDifferentCasing_TracksItOnce_AndRefusesTheModThatProvidesNothingOnItsOwn()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.TrackHandler(_holder);

        var result = await handler.TrackAsync([Origin, "NoSuchMod", Origin.ToUpperInvariant()]);

        Assert.Equal([Origin], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(("NoSuchMod", TrackRefusal.ModProvidesNoPlugin), (refused.Item, refused.Refusal));
        Assert.Null(result.SelectionRefusal);
    }
}
