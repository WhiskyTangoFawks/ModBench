using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public class PluginFactsTests
{
    private static readonly PluginAddress ModA = new("Shared.esp", "ModA");
    private static readonly PluginAddress ModB = new("Shared.esp", "ModB");
    private static readonly PluginAddress Other = new("Other.esp", "ModC");

    private static PluginFixtureBuilder Plugins() => new PluginFixtureBuilder("plugin-facts")
        .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("InBoth"), origin: "ModA")
        .WithPlugin("Shared.esp", mod =>
        {
            mod.Npcs.AddNew("InBoth");
            mod.Npcs.AddNew("OnlyInModB");
        }, origin: "ModB")
        .WithPlugin("Other.esp", mod => mod.Npcs.AddNew("Elsewhere"), origin: "ModC");

    public static TheoryData<PluginAddress[], PluginAddress[]> NamedAndAnswered => new()
    {
        { [ModB, Other], [ModB, Other] },
        { [ModA], [ModA] },
        { [], [] },
    };

    [Theory]
    [MemberData(nameof(NamedAndAnswered))]
    public void PluginsNamed_AreTheOnlyPluginsAnswered_EachOfTheOriginAsked(PluginAddress[] named, PluginAddress[] answered)
    {
        using var plugins = Plugins().BuildScattered();
        using var index = Indexes.Reconciled(plugins);

        var facts = index.Queries.GetPlugins(named).Value().Select(row => row.KeyOf());

        Assert.Equal(answered.ToHashSet(), facts.ToHashSet());
    }

    [Fact]
    public void ANamedPluginsFacts_AreTheFactsTheWholeAnswerHoldsForIt()
    {
        using var plugins = Plugins().BuildScattered();
        using var index = Indexes.Reconciled(plugins);
        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'OnlyInModB'", "filter.sql");

        var named = index.Queries.GetPlugins([ModA, ModB]).Value();

        var whole = index.Queries.GetPlugins().Value().Where(row => named.Any(n => n.KeyOf() == row.KeyOf()));
        Assert.Equal(whole, named);
        Assert.Equal([ModB], named.Where(row => row.HasMatchingRecords).Select(row => row.KeyOf()));
    }

    [Fact]
    public void NoPluginsNamed_AnswerEveryPlugin()
    {
        using var plugins = Plugins().BuildScattered();
        using var index = Indexes.Reconciled(plugins);

        Assert.Equal(3, index.Queries.GetPlugins().Value().Count);
    }
}
