using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Query;

public sealed class PluginRowImmutabilityTests
{
    private static bool IsImmutable(string origin, bool enabled, bool gameProvided)
    {
        using var fixture = new PluginFixtureBuilder("medit-immutable")
            .WithPlugin("A.esp", mod => mod.Npcs.Add(new Npc(mod.GetNextFormKey(), Fallout4Release.Fallout4) { EditorID = "FromA" }), enabled: enabled, origin: origin)
            .BuildScattered();
        var plugins = gameProvided
            ? fixture.Plugins.Select(p => p with { NamedProvider = PluginProvider.Game }).ToList()
            : fixture.Plugins;
        using var index = Indexes.Reconciled(fixture.GameDirectory, plugins);

        return index.Records.GetPlugins().Value().Single().IsImmutable;
    }

    [Fact]
    public void GetPlugins_APluginTheGameProvides_IsImmutable() =>
        Assert.True(IsImmutable("ModA", enabled: true, gameProvided: true));

    [Fact]
    public void GetPlugins_APluginAModProvides_IsEditable() =>
        Assert.False(IsImmutable("ModA", enabled: true, gameProvided: false));

    [Fact]
    public void GetPlugins_ADisabledPluginAModProvides_IsEditable() =>
        Assert.False(IsImmutable("ModA", enabled: false, gameProvided: false));

    [Fact]
    public void GetPlugins_APluginNoModProvides_IsEditable() =>
        Assert.False(IsImmutable(PluginOrigin.Overwrite, enabled: true, gameProvided: false));
}
