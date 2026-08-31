using MEditService.Core.Plugins;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

// ADR-0036: PluginOriginResolver answers "which origin does this bare filename mean?" for
// every call site that only has a filename to work with, and
// the read routes that resolve origin server-side. Once a load order can hold two copies of one
// filename, that question has two candidate answers and only one correct one: the copy the game
// actually loads.
//
// The rule is scoping, not ordering. `FirstOrDefault(p => p.Name == plugin)` happens to return the
// right plugin today purely because unlisted copies are appended after the load order is built —
// an accident of list order, not an invariant, and one that any future change to how Plugins is
// assembled or sorted would silently break. These tests state the rule directly by putting the
// shadowed copy first.
public sealed class PluginOriginResolverTests
{
    private static ILoadOrder LoadOrderWith(params PluginMetadata[] plugins) => new StubLoadOrder(plugins);

    private static PluginMetadata Plugin(string name, string origin, bool inLoadOrder) =>
        new(name, Path: "", LoadOrderIndex: 0, IsLight: false, IsMaster: false, Masters: [], RecordCount: 0,
            IsForced: false, Origin: origin, Enabled: true, Winning: inLoadOrder);

    [Fact]
    public void Resolve_ShadowedCopyListedFirst_StillResolvesTheLoadOrderCopy()
    {
        var loadOrder = LoadOrderWith(
            Plugin("Shared.esp", "ModB", inLoadOrder: false),
            Plugin("Shared.esp", "ModA", inLoadOrder: true));

        Assert.Equal("ModA", PluginOriginResolver.Resolve(loadOrder, "Shared.esp"));
    }

    [Fact]
    public void Resolve_OnlyCopyIsOutsideTheLoadOrder_FallsBackRatherThanNamingIt()
    {
        // A write target that is not in the load order is not a legitimate target at all, so
        // resolving to its origin would attribute a read to a file the game never loads.
        // The reserved fallback keeps that impossible; the caller's own guards reject the edit.
        var loadOrder = LoadOrderWith(Plugin("Orphan.esp", "SomeMod", inLoadOrder: false));

        Assert.Equal(PluginOrigin.DataDirectory, PluginOriginResolver.Resolve(loadOrder, "Orphan.esp"));
    }

    [Fact]
    public void Resolve_DisabledLoadOrderPlugin_ResolvesNormally()
    {
        // Participation is not membership: a disabled plugins.txt line is still in the load order
        // and is still a legitimate write target (ADR-0035).
        var disabled = Plugin("Disabled.esp", "SomeMod", inLoadOrder: true) with { Enabled = false };
        var loadOrder = LoadOrderWith(disabled);

        Assert.Equal("SomeMod", PluginOriginResolver.Resolve(loadOrder, "Disabled.esp"));
    }

    // LoadOrderPlugin is Resolve's own building block, exposed directly for the six write-path
    // guards that need the metadata itself (IsImmutable), not just the origin string. Same scoping,
    // same reason: a plain first-match happens to return the right plugin today only because
    // unlisted copies are appended after the load order is built, never because of any invariant.
    [Fact]
    public void LoadOrderPlugin_ShadowedCopyListedFirst_StillReturnsTheLoadOrderCopy()
    {
        var loadOrder = LoadOrderWith(
            Plugin("Shared.esp", "ModB", inLoadOrder: false),
            Plugin("Shared.esp", "ModA", inLoadOrder: true));

        var meta = loadOrder.LoadOrderPlugin("Shared.esp");

        Assert.NotNull(meta);
        Assert.Equal("ModA", meta.Origin);
        Assert.False(meta.IsImmutable);
    }

    // Null is the answer for "no load-order member of this name" — callers must read it as a
    // refusal, not as "not immutable".
    [Fact]
    public void LoadOrderPlugin_OnlyCopyIsOutsideTheLoadOrder_ReturnsNull()
    {
        var loadOrder = LoadOrderWith(Plugin("Orphan.esp", "SomeMod", inLoadOrder: false));

        Assert.Null(loadOrder.LoadOrderPlugin("Orphan.esp"));
    }

    [Fact]
    public void LoadOrderPlugin_NoLoadOrder_ReturnsNull()
    {
        ILoadOrder? loadOrder = null;

        Assert.Null(loadOrder.LoadOrderPlugin("Anything.esp"));
    }

    private sealed class StubLoadOrder(IReadOnlyList<PluginMetadata> plugins) : ILoadOrder
    {
        public string DataFolderPath => throw new NotSupportedException();
        public string? InstanceRoot => throw new NotSupportedException();
        public GameRelease GameRelease => GameRelease.Fallout4;
        public IReadOnlyList<PluginMetadata> Plugins { get; } = plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public IModGetter? GetMod(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
