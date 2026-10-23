using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class DependantsTests
{
    private static readonly PluginAddress Renamed = new("Base.esm", "BaseMod");

    private sealed record Plugin(string Name, string Origin = "SomeMod", bool Enabled = true, params string[] Masters)
    {
        public PluginAddress Key => new(Name, Origin);
    }

    private static readonly Plugin Base = new(Renamed.Name, Renamed.Origin);

    private static ScatteredFixtureData Fixture(params Plugin[] plugins)
    {
        var builder = new PluginFixtureBuilder("plugin-dependants");
        foreach (var plugin in plugins)
        {
            builder.WithPlugin(
                plugin.Name,
                mod =>
                {
                    foreach (var master in plugin.Masters)
                        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(master) });
                },
                writeParams: new BinaryWriteParameters { MastersListContent = MastersListContentOption.NoCheck },
                enabled: plugin.Enabled,
                origin: plugin.Origin);
        }
        return builder.BuildScattered();
    }

    private static PluginDependants Ready(params Plugin[] plugins)
    {
        using var fixture = Fixture(plugins);
        using var index = Indexes.Reconciled(fixture);
        return index.Queries.GetDependants(Renamed).Value();
    }

    [Fact]
    public void GetDependants_APluginListingTheNameAsAMaster_IsADependant()
    {
        var child = new Plugin("Child.esp", Masters: "Base.esm");

        var answer = Ready(Base, child, new Plugin("Other.esp", Masters: "Fallout4.esm"));

        Assert.Equal([child.Key], answer.Dependants);
        Assert.Empty(answer.Unreadable);
    }

    [Fact]
    public void GetDependants_TheMasterNameInAnotherCase_StillMatches_ForAFileNameIsComparedWithoutCase()
    {
        var child = new Plugin("Child.esp", Masters: "BASE.ESM");

        Assert.Equal([child.Key], Ready(Base, child).Dependants);
    }

    [Fact]
    public void GetDependants_AnInactivePlugin_IsADependant_ForTheIndexHoldsEveryPluginOfTheInstance()
    {
        var child = new Plugin("Child.esp", Enabled: false, Masters: "Base.esm");

        Assert.Equal([child.Key], Ready(Base, child).Dependants);
    }

    [Fact]
    public void GetDependants_ThePluginItself_IsNeverItsOwnDependant()
    {
        Assert.Empty(Ready(Base with { Masters = ["Base.esm"] }).Dependants);
    }

    [Fact]
    public void GetDependants_APluginWhoseMastersWereNotRead_IsUnreadable_ForItMayListTheName()
    {
        var unread = new Plugin("Unread.esp", Masters: "Base.esm");
        using var fixture = Fixture(Base, unread);
        byte[] truncatedBelowATes4Header = [0x54, 0x45, 0x53, 0x34, 0xFF];
        File.WriteAllBytes(fixture.Plugins.Single(p => p.Name == unread.Name).Path, truncatedBelowATes4Header);
        using var index = Indexes.Reconciled(fixture);

        var answer = index.Queries.GetDependants(Renamed).Value();

        Assert.Equal([unread.Key], answer.Unreadable);
        Assert.Empty(answer.Dependants);
    }

}
