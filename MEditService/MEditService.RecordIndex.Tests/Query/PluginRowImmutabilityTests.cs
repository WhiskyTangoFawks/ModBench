using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Query;

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
        using var index = Indexes.Reconciled(fixture.DataFolder, plugins);

        return index.Queries.GetPlugins().Value().Single().IsImmutable;
    }

    [Theory]
    [InlineData("ModA", true, true, true)]
    [InlineData("ModA", true, false, false)]
    [InlineData("ModA", false, false, false)]
    [InlineData(LoadOrderEntry.OverwriteOrigin, true, false, false)]
    public void OnlyAPluginTheGameProvides_IsImmutable(string origin, bool enabled, bool gameProvided, bool immutable)
    {
        Assert.Equal(immutable, IsImmutable(origin, enabled, gameProvided));
    }
}
