using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Edits;

public sealed class PutLoadOrderHandlerTests : IDisposable
{
    private readonly ScratchDirectory _dataFolder = new("medit-put-load-order-");
    private readonly ScratchDirectory _instanceRoot = new("medit-put-load-order-instance-");
    private readonly LoadOrderHolder _holder = new();

    private PutLoadOrderHandler Handler => TestEditService.PutLoadOrderHandler(_holder);

    private static RegisteredPlugin Plugin(string name) => new(name, "ModA", $"C:\\Instance\\mods\\ModA\\{name}", new PluginProvider.FromMod("ModA", "C:\\Instance\\mods\\ModA", "C:\\Instance\\mods\\ModA"), Line: null, PluginStrings.None);

    private Answer<PutLoadOrderApplied, PutLoadOrderRefused> Put(GameRelease release, RegisteredPlugin[] plugins, params RegisteredPlugin[] active) =>
        Handler.Put(_dataFolder, _instanceRoot, release, plugins, [.. active.Select(p => p.Key)], [], [], [], [], Language.English);

    private static PutLoadOrderRefused Refused(Answer<PutLoadOrderApplied, PutLoadOrderRefused> answer)
    {
        Assert.False(answer.Holds(out _, out var refused));
        return refused;
    }

    public void Dispose()
    {
        _dataFolder.Dispose();
        _instanceRoot.Dispose();
    }

    [Fact]
    public void ALoadOrderOfASupportedRelease_IsHeldAsState()
    {
        var a = Plugin("A.esp");
        var b = Plugin("B.esp");

        var result = Put(GameRelease.Fallout4, [a, b], b);

        Assert.True(result.Holds(out var applied, out _));
        Assert.Equal(_dataFolder.Path, _holder.Current.DataFolderPath);
        Assert.Equal(_instanceRoot.Path, _holder.Current.InstanceRoot);
        Assert.Equal(GameRelease.Fallout4, _holder.Current.GameRelease);
        Assert.Equal([a, b], _holder.Current.Plugins);
        Assert.Equal([b], _holder.Current.Active);
        Assert.Equal(_holder.Held?.Version, applied.Version);
    }

    [Fact]
    public void ALoadOrderWithTwoActivePluginsOfOneFilename_IsRefused_AndNothingIsHeld()
    {
        var a = Plugin("A.esp");
        var other = a with { Origin = "ModB" };

        var result = Refused(Put(GameRelease.Fallout4, [a, other], a, other));

        Assert.Equal(PutLoadOrderRefusal.InvalidSnapshot, result.Refusal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void ALoadOrderOfAnUnsupportedRelease_IsRefused_AndNothingIsHeld()
    {
        var result = Refused(Put(GameRelease.Oblivion, [Plugin("A.esp")]));

        Assert.Equal(PutLoadOrderRefusal.UnsupportedGameRelease, result.Refusal);
        Assert.Contains("Oblivion", result.Message, StringComparison.Ordinal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void ALoadOrderWhoseDataFolderIsNotThere_IsRefused_AndNothingIsHeld()
    {
        var gone = Path.Combine(_dataFolder, "no-such-data");

        var result = Refused(Handler.Put(gone, _instanceRoot, GameRelease.Fallout4, [Plugin("A.esp")], [], [], [], [], [], Language.English));

        Assert.Equal(PutLoadOrderRefusal.DataFolderNotFound, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
        Assert.Null(_holder.Held);
    }

    [Fact]
    public void ALoadOrderWithAMissingFolderAndAnUnsupportedRelease_IsRefusedForTheFolder()
    {
        var gone = Path.Combine(_dataFolder, "no-such-data");

        var result = Refused(Handler.Put(gone, _instanceRoot, GameRelease.Oblivion, [Plugin("A.esp")], [], [], [], [], [], Language.English));

        Assert.Equal(PutLoadOrderRefusal.DataFolderNotFound, result.Refusal);
    }
}
