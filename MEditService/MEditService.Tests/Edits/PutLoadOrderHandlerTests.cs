using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

// ADR-0013: the handler that turns a validated snapshot into Load order state's one arrival —
// what a reconcile does with that arrival is the Index's subscription, not this handler's.
public sealed class PutLoadOrderHandlerTests
{
    private readonly LoadOrderHolder _holder = new();
    private PutLoadOrderHandler Handler => TestEditService.PutLoadOrderHandler(_holder);

    private static string NewDirectory() => Directory.CreateTempSubdirectory("medit-put-load-order-").FullName;

    [Fact]
    public void Put_WithAValidSnapshot_AppliesItToLoadOrderState()
    {
        var gameDirectory = NewDirectory();
        var instanceRoot = NewDirectory();
        var entries = new[] { new LoadOrderEntry("A.esp", Path.Combine(instanceRoot, "A.esp"), "ModA", 0, true, true) };

        var result = Handler.Put(entries, gameDirectory, instanceRoot, "Fallout4");

        Assert.True(result.Applied);
        Assert.Contains(_holder.Current.Copies, c => c.Name == "A.esp" && c.Origin == "ModA");
        Assert.Equal(gameDirectory, _holder.Current.DataFolderPath);
        Assert.Equal(instanceRoot, _holder.Current.InstanceRoot);
        Assert.Equal(GameRelease.Fallout4, _holder.Current.GameRelease);
    }

    [Fact]
    public void Put_MissingGameDirectory_RefusesWithoutApplying()
    {
        var instanceRoot = NewDirectory();
        var missing = Path.Combine(NewDirectory(), "does-not-exist");

        var result = Handler.Put([], missing, instanceRoot, "Fallout4");

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.GameDirectoryNotFound, result.Refusal);
        Assert.Contains(missing, result.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }

    [Fact]
    public void Put_MissingInstanceRoot_RefusesWithoutApplying()
    {
        var gameDirectory = NewDirectory();
        var missing = Path.Combine(NewDirectory(), "does-not-exist");

        var result = Handler.Put([], gameDirectory, missing, "Fallout4");

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.InstanceRootNotFound, result.Refusal);
        Assert.Contains(missing, result.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }

    [Fact]
    public void Put_UnknownGameRelease_RefusesWithoutApplying()
    {
        var gameDirectory = NewDirectory();
        var instanceRoot = NewDirectory();

        var result = Handler.Put([], gameDirectory, instanceRoot, "NotAGame");

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.UnknownGameRelease, result.Refusal);
        Assert.Contains("NotAGame", result.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }

    // A release this build has no Mutagen assembly for: a bad request, discovered as soon as the
    // handler asks whether the release is supported, never inside a reconcile the caller cannot see.
    [Fact]
    public void Put_UnsupportedGameRelease_RefusesWithoutApplying()
    {
        var gameDirectory = NewDirectory();
        var instanceRoot = NewDirectory();

        var result = Handler.Put([], gameDirectory, instanceRoot, "SkyrimSE");

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.UnsupportedGameRelease, result.Refusal);
        Assert.Contains("SkyrimSE", result.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }

    [Fact]
    public void Put_PrependsTheForcedPlugins_AheadOfTheEnteredCopies()
    {
        var gameDirectory = NewDirectory();
        var instanceRoot = NewDirectory();
        File.WriteAllBytes(Path.Combine(gameDirectory, "Fallout4.esm"), []);
        var entries = new[] { new LoadOrderEntry("A.esp", Path.Combine(instanceRoot, "A.esp"), "ModA", 0, true, true) };

        Handler.Put(entries, gameDirectory, instanceRoot, "Fallout4");

        var copy = Assert.Single(_holder.Current.Copies, c => c.Name == "Fallout4.esm");
        Assert.True(copy.IsForced);
    }
}
