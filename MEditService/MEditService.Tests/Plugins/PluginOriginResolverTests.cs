using MEditService.Core.Plugins;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

// ADR-0036: once a load order can hold two copies of one filename, "which origin does this bare
// filename mean?" has two candidates and one right answer.
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
        // A write target absent from the load order is not a legitimate target, so resolving to its origin
        // would attribute a read to a file the game never loads. The reserved fallback keeps that
        // impossible.
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

    // LoadOrderPlugin is Resolve's own building block, exposed for the write-path guards that need the
    // metadata itself rather than the origin string. Same scoping, same reason: a plain first match is
    // an accident of list order.
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
        public IModGetter? GetMod(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
