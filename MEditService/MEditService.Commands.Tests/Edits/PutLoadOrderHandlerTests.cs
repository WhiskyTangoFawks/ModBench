using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class PutLoadOrderHandlerTests : IDisposable
{
    private readonly ScratchDirectory _dataFolder = new("medit-put-load-order-");
    private readonly ScratchDirectory _instanceRoot = new("medit-put-load-order-instance-");
    private readonly LoadOrderHolder _holder = new();

    private PutLoadOrderHandler Handler => TestEditService.PutLoadOrderHandler(_holder);

    private static RegisteredPlugin Plugin(string name) => new(name, "ModA", $"C:\\Instance\\mods\\ModA\\{name}", new PluginProvider.FromMod("ModA", "C:\\Instance\\mods\\ModA"), Line: null);

    private PutLoadOrderResult Put(GameRelease release, RegisteredPlugin[] plugins, params RegisteredPlugin[] active) =>
        Handler.Put(_dataFolder, _instanceRoot, release, plugins, [.. active.Select(p => p.Key)], []);

    public void Dispose()
    {
        _dataFolder.Dispose();
        _instanceRoot.Dispose();
    }

    [Fact]
    public void Put_WithASupportedRelease_AppliesTheSnapshotToLoadOrderState()
    {
        var a = Plugin("A.esp");
        var b = Plugin("B.esp");

        var result = Put(GameRelease.Fallout4, [a, b], b);

        Assert.True(result.Applied);
        Assert.Equal(_dataFolder.Path, _holder.Current.DataFolderPath);
        Assert.Equal(_instanceRoot.Path, _holder.Current.InstanceRoot);
        Assert.Equal(GameRelease.Fallout4, _holder.Current.GameRelease);
        Assert.Equal([a, b], _holder.Current.Plugins);
        Assert.Equal([b], _holder.Current.Active);
        Assert.Equal(_holder.Held?.Version, result.Version);
    }

    [Fact]
    public void Put_TwoActivePluginsOfOneFilename_RefusesWithoutApplying()
    {
        var a = Plugin("A.esp");
        var other = a with { Origin = "ModB" };

        var result = Put(GameRelease.Fallout4, [a, other], a, other);

        Assert.Equal(PutLoadOrderRefusal.InvalidSnapshot, result.Refusal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void Put_UnsupportedGameRelease_RefusesWithoutApplying()
    {
        var result = Put(GameRelease.SkyrimSE, [Plugin("A.esp")]);

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.UnsupportedGameRelease, result.Refusal);
        Assert.Contains("SkyrimSE", result.Message, StringComparison.Ordinal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void Put_AGameDirectoryThatIsNotThere_RefusesWithoutApplying()
    {
        var gone = Path.Combine(_dataFolder, "no-such-data");

        var result = Handler.Put(gone, _instanceRoot, GameRelease.Fallout4, [Plugin("A.esp")], [], []);

        Assert.Equal(PutLoadOrderRefusal.GameDirectoryNotFound, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void Put_AnInstanceRootThatIsNotThere_RefusesWithoutApplying()
    {
        var gone = Path.Combine(_instanceRoot, "no-such-instance");

        var result = Handler.Put(_dataFolder, gone, GameRelease.Fallout4, [Plugin("A.esp")], [], []);

        Assert.Equal(PutLoadOrderRefusal.InstanceRootNotFound, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void Put_NoInstanceRoot_RefusesWithoutApplying()
    {
        var result = Handler.Put(_dataFolder, null, GameRelease.Fallout4, [Plugin("A.esp")], [], []);

        Assert.Equal(PutLoadOrderRefusal.InstanceRootNotFound, result.Refusal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void Put_AFolderThatIsNotThereAndAnUnsupportedRelease_RefusesTheFolderFirst()
    {
        var gone = Path.Combine(_dataFolder, "no-such-data");

        var result = Handler.Put(gone, _instanceRoot, GameRelease.SkyrimSE, [Plugin("A.esp")], [], []);

        Assert.Equal(PutLoadOrderRefusal.GameDirectoryNotFound, result.Refusal);
    }
}
