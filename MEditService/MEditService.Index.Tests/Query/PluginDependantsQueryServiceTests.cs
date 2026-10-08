using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

public sealed class PluginDependantsQueryServiceTests
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
        return index.Dependants.GetDependants(Renamed);
    }

    [Fact]
    public void GetDependants_APluginListingTheNameAsAMaster_IsADependant()
    {
        var child = new Plugin("Child.esp", Masters: "Base.esm");

        var answer = Ready(Base, child, new Plugin("Other.esp", Masters: "Fallout4.esm"));

        Assert.Equal([child.Key], answer.Plugins);
        Assert.Empty(answer.Unreadable);
    }

    [Fact]
    public void GetDependants_TheMasterNameInAnotherCase_StillMatches_ForAFileNameIsComparedWithoutCase()
    {
        var child = new Plugin("Child.esp", Masters: "BASE.ESM");

        Assert.Equal([child.Key], Ready(Base, child).Plugins);
    }

    [Fact]
    public void GetDependants_AnInactivePlugin_IsADependant_ForTheIndexHoldsEveryPluginOfTheInstance()
    {
        var child = new Plugin("Child.esp", Enabled: false, Masters: "Base.esm");

        Assert.Equal([child.Key], Ready(Base, child).Plugins);
    }

    [Fact]
    public void GetDependants_ThePluginItself_IsNeverItsOwnDependant()
    {
        Assert.Empty(Ready(Base with { Masters = ["Base.esm"] }).Plugins);
    }

    [Fact]
    public void GetDependants_APluginWhoseMastersWereNotRead_IsUnreadable_ForItMayListTheName()
    {
        var unread = new Plugin("Unread.esp", Masters: "Base.esm");
        using var fixture = Fixture(Base, unread);
        byte[] truncatedBelowATes4Header = [0x54, 0x45, 0x53, 0x34, 0xFF];
        File.WriteAllBytes(fixture.Plugins.Single(p => p.Name == unread.Name).Path, truncatedBelowATes4Header);
        using var index = Indexes.Reconciled(fixture);

        var answer = index.Dependants.GetDependants(Renamed);

        Assert.Equal([unread.Key], answer.Unreadable);
        Assert.Empty(answer.Plugins);
    }

    [Fact]
    public async Task GetDependants_WhileTheIndexIsReconciling_IsNotReady_ForAPluginNotYetOpenedWouldReadAsNoDependant()
    {
        var child = new Plugin("Child.esp", Masters: "Base.esm");
        using var fixture = Fixture(Base, child);
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: child.Name);
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        Assert.Throws<IndexNotReadyException>(() => index.Dependants.GetDependants(Renamed));

        gate.Release();
        await load;
    }

    [Fact]
    public void GetDependants_WhenTheIndexFailed_IsNotReady_ForAPluginNotYetOpenedWouldReadAsNoDependant()
    {
        using var fixture = Fixture(Base, new Plugin("Child.esp", Masters: "Base.esm"));
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.SkyrimSE);
        Assert.Equal(LoadOrderState.Failed, index.Status.State);

        Assert.Throws<IndexNotReadyException>(() => index.Dependants.GetDependants(Renamed));
    }

    [Fact]
    public void GetDependants_WithNoLoadOrderHeld_Throws()
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(() => index.Dependants.GetDependants(Renamed));
    }
}
