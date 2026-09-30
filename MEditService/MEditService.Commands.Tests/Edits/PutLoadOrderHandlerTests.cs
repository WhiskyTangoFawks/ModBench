using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

// ADR-0013: the handler that turns a validated snapshot into Load order state's one arrival —
// what a reconcile does with that arrival is the Index's subscription, not this handler's.
public sealed class PutLoadOrderHandlerTests : IDisposable
{
    private const string InstanceRoot = "C:\\Instance";

    private readonly string _dataFolder = Directory.CreateTempSubdirectory("medit-put-load-order-").FullName;
    private readonly LoadOrderHolder _holder = new();

    private PutLoadOrderHandler Handler => TestEditService.PutLoadOrderHandler(_holder);

    private static RegisteredPlugin Plugin(string name) => new(name, "ModA", $"C:\\Instance\\mods\\ModA\\{name}");

    private PutLoadOrderResult Put(GameRelease release, RegisteredPlugin[] plugins, params RegisteredPlugin[] active) =>
        Handler.Put(_dataFolder, InstanceRoot, release, plugins, [.. active.Select(p => p.Key)]);

    public void Dispose() => Directory.Delete(_dataFolder, recursive: true);

    [Fact]
    public void Put_WithASupportedRelease_AppliesTheSnapshotToLoadOrderState()
    {
        var a = Plugin("A.esp");
        var b = Plugin("B.esp");

        var result = Put(GameRelease.Fallout4, [a, b], b);

        Assert.True(result.Applied);
        Assert.Equal(_dataFolder, _holder.Current.DataFolderPath);
        Assert.Equal(InstanceRoot, _holder.Current.InstanceRoot);
        Assert.Equal(GameRelease.Fallout4, _holder.Current.GameRelease);
        Assert.Equal([a, b], _holder.Current.Plugins);
        Assert.Equal([b], _holder.Current.Active);
        Assert.Equal(_holder.Version, result.Version);
    }

    // ADR-0013 invariant 3: the game's masters are Mod Management's to send. A master in the Data
    // folder that the snapshot does not name is neither a plugin nor active here.
    [Fact]
    public void Put_AddsNoPluginTheSnapshotDoesNotName_EvenTheGamesMasterInTheDataFolder()
    {
        File.WriteAllBytes(Path.Combine(_dataFolder, "Fallout4.esm"), []);
        var a = Plugin("A.esp");

        Put(GameRelease.Fallout4, [a], a);

        Assert.Equal([a], _holder.Current.Plugins);
        Assert.Equal([a], _holder.Current.Active);
    }

    [Fact]
    public void Put_TwoActivePluginsOfOneFilename_RefusesWithoutApplying()
    {
        var a = Plugin("A.esp");
        var other = a with { Origin = "ModB" };

        var result = Put(GameRelease.Fallout4, [a, other], a, other);

        Assert.Equal(PutLoadOrderRefusal.InvalidSnapshot, result.Refusal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }

    // A release this build has no Mutagen assembly for is discovered here, synchronously, never
    // inside a reconcile the caller cannot see.
    [Fact]
    public void Put_UnsupportedGameRelease_RefusesWithoutApplying()
    {
        var result = Put(GameRelease.SkyrimSE, [Plugin("A.esp")]);

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.UnsupportedGameRelease, result.Refusal);
        Assert.Contains("SkyrimSE", result.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }
}
