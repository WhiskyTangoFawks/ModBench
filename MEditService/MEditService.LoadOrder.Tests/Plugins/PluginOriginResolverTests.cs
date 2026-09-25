using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.LoadOrder.Tests.Plugins;

// ADR-0012: once a load order can hold two plugins that share a filename, "which origin does this
// bare filename mean?" has two candidates and one right answer.
public sealed class PluginOriginResolverTests
{
    private static LoadOrderSnapshot LoadOrderWith(params RegisteredPlugin[] plugins) =>
        new(@"C:\Games\Fallout4\Data", @"C:\MO2\Fallout4", GameRelease.Fallout4, plugins);

    private static RegisteredPlugin Registered(string name, string origin, bool inLoadOrder) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), Slot: 0, Enabled: true, Winning: inLoadOrder);

    [Fact]
    public void Resolve_OverriddenPluginListedFirst_StillResolvesTheLoadOrderPlugin()
    {
        var loadOrder = LoadOrderWith(
            Registered("Shared.esp", "ModB", inLoadOrder: false),
            Registered("Shared.esp", "ModA", inLoadOrder: true));

        Assert.Equal("ModA", PluginOriginResolver.Resolve(loadOrder, "Shared.esp"));
    }

    [Fact]
    public void Resolve_OnlyPluginIsOutsideTheLoadOrder_FallsBackRatherThanNamingIt()
    {
        // A write target absent from the load order is not a legitimate target, so resolving to its origin
        // would attribute a read to a file the game never loads. The reserved fallback keeps that
        // impossible.
        var loadOrder = LoadOrderWith(Registered("Orphan.esp", "SomeMod", inLoadOrder: false));

        Assert.Equal(PluginOrigin.DataDirectory, PluginOriginResolver.Resolve(loadOrder, "Orphan.esp"));
    }

    [Fact]
    public void Resolve_DisabledLoadOrderPlugin_ResolvesNormally()
    {
        // Participation is not membership: a disabled plugins.txt line is still in the load order
        // and is still a legitimate write target (ADR-0013).
        var disabled = Registered("Disabled.esp", "SomeMod", inLoadOrder: true) with { Enabled = false };
        var loadOrder = LoadOrderWith(disabled);

        Assert.Equal("SomeMod", PluginOriginResolver.Resolve(loadOrder, "Disabled.esp"));
    }

    [Fact]
    public void Resolve_UnlistedPlugin_FallsBackEvenThoughItWins()
    {
        // No plugins.txt line, so no slot: the Mod override order still names a winner among the
        // plugins, and that is not load-order membership.
        var unlisted = Registered("Loose.esp", "SomeMod", inLoadOrder: true) with { Slot = null };
        var loadOrder = LoadOrderWith(unlisted);

        Assert.Equal(PluginOrigin.DataDirectory, PluginOriginResolver.Resolve(loadOrder, "Loose.esp"));
    }

    [Fact]
    public void Resolve_NoLoadOrderApplied_FallsBack()
    {
        Assert.Equal(PluginOrigin.DataDirectory, PluginOriginResolver.Resolve(LoadOrderSnapshot.Empty, "Anything.esp"));
    }
}
