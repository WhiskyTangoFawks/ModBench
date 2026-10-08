using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Query;

public class PluginRowImmutabilityTests
{
    private static bool ImmutableWhenProvidedBy(PluginProvider provider)
    {
        using var fixture = new PluginFixtureBuilder("medit-immutable")
            .WithPlugin("A.esp", mod => mod.Npcs.Add(new Npc(mod.GetNextFormKey(), Fallout4Release.Fallout4) { EditorID = "FromA" }), origin: "ModA")
            .BuildScattered();
        var plugins = fixture.Plugins.Select(p => p with { NamedProvider = provider }).ToList();
        using var index = Indexes.Reconciled(fixture.GameDirectory, plugins);

        return index.Records.GetPlugins().Single().IsImmutable;
    }

    [Fact]
    public void GetPlugins_APluginTheGameProvides_IsImmutable() =>
        Assert.True(ImmutableWhenProvidedBy(PluginProvider.Game));

    [Fact]
    public void GetPlugins_APluginAModProvides_IsEditable() =>
        Assert.False(ImmutableWhenProvidedBy(new PluginProvider.FromMod("ModA", "/mods/ModA")));

    [Fact]
    public void GetPlugins_APluginNoModProvides_IsEditable() =>
        Assert.False(ImmutableWhenProvidedBy(PluginProvider.NoMod));
}
