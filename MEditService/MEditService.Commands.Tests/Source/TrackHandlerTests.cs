using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Source;

/// <summary>The Track gesture's door takes the origin and the preset; the load order it tracks
/// against is the holder's, read here and never handed in (ADR-0013 invariant 4).</summary>
public sealed class TrackHandlerTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-track-handler-").FullName;
    private readonly LoadOrderHolder _holder = new();
    private readonly string _modFolder;

    public TrackHandlerTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        var gameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FixtureNpc");
        mod.WriteToBinary(pluginPath);

        Snapshot = new LoadOrderSnapshot(gameDirectory, _instanceRoot, GameRelease.Fallout4,
            [new RegisteredCopy(PluginName, Origin, pluginPath, 0, Enabled: true, Winning: true)]);
    }

    private LoadOrderSnapshot Snapshot { get; }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_instanceRoot, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A temp tree another process still holds outlives the test; nothing here depends on it.
        }
    }

    // The 503 the endpoint maps. A door reading the holder's Current instead would refuse with
    // NoPluginWithOrigin, which says the mod is missing rather than the load order.
    [Fact]
    public async Task Track_WithNoLoadOrderHeld_ThrowsNoLoadOrder()
    {
        var handler = TestEditService.TrackHandler(_holder);

        await Assert.ThrowsAsync<NoLoadOrderException>(
            () => handler.TrackAsync(Origin, SourcePreset.Edits));
    }

    [Fact]
    public async Task Track_OverTheHeldLoadOrder_TracksTheOriginsModFolder()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.TrackHandler(_holder);

        var result = await handler.TrackAsync(Origin, SourcePreset.Edits);

        Assert.True(result.Applied, result.Message);
        Assert.True(SourceRepository.HoldsTreeFor(_modFolder, PluginName));
    }
}
