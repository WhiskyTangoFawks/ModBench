using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class CommittedOnlyReadPathTests
{
    private const string PluginName = "TestPlugin.esp";

    [Fact]
    public void GetCompare_OverrideCarriesTheCommittedFieldValue_AnOmittedOneReadingAsAbsent()
    {
        FormKey npc01Key = default;
        using var fixture = new PluginFixtureBuilder("medit-committed-only")
            .WithPlugin(PluginName, mod =>
            {
                npc01Key = mod.Npcs.AddNew("TestNPC01").FormKey;
                mod.Npcs.AddNew("TestNPC02");
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var compare = index.Queries.GetCompare(npc01Key.ToString()).Value();

        Assert.NotNull(compare);
        var only = Assert.Single(compare.Overrides);
        Assert.Equal(PluginName, only.Plugin);
        Assert.Equal("TestNPC01", only.EditorId);
        var flags = Assert.Single(only.Fields, f => f.Metadata.Name == "MajorRecordFlagsRaw");
        Assert.Null(flags.Value);
    }
}
