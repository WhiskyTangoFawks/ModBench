using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

public sealed class PluginDependantsQueryServiceTests
{
    private static readonly PluginAddress Renamed = new("Base.esm", "BaseMod");

    private static LoadOrderEntry Entry(string name, string origin = "SomeMod", bool enabled = true) =>
        new(name, $@"C:\mods\{origin}\{name}", origin, enabled ? 0 : null, enabled, Winning: true);

    private static PluginContent Content(params string[] masters) =>
        new(IsLight: false, IsMaster: false, IsBlueprint: false, masters, RecordCount: 0, IsMedium: false);

    private static PluginDependants Ready(params (LoadOrderEntry Entry, PluginContent? Content)[] plugins) =>
        Ask(LoadOrderState.Ready, plugins) ?? throw new InvalidOperationException("The index was ready.");

    private static PluginDependants? Ask(
        LoadOrderState state, params (LoadOrderEntry Entry, PluginContent? Content)[] plugins)
    {
        var opened = new Dictionary<PluginAddress, PluginContent>(PluginAddress.Comparer);
        foreach (var (entry, content) in plugins)
        {
            if (content is not null) opened[entry.Key] = content;
        }
        var status = new LoadOrderStatus(state, plugins.Length, plugins.Length, [], ConflictsComputed: false, []);
        return new PluginDependantsQueryService(
            new FakeIndex(new FakeReads(opened, []), status),
            FakeLoadOrder.Of(GameRelease.Fallout4, [.. plugins.Select(p => p.Entry)]))
            .GetDependants(Renamed);
    }

    private static (LoadOrderEntry Entry, PluginContent? Content) Base() => (Entry("Base.esm", "BaseMod"), Content());

    [Fact]
    public void GetDependants_APluginListingTheNameAsAMaster_IsADependant()
    {
        var child = Entry("Child.esp");

        var answer = Ready(Base(), (child, Content("Base.esm")), (Entry("Other.esp"), Content("Fallout4.esm")));

        Assert.Equal([child.Key], answer.Plugins);
        Assert.Empty(answer.Unreadable);
    }

    [Fact]
    public void GetDependants_TheMasterNameInAnotherCase_StillMatches_ForAFileNameIsComparedWithoutCase()
    {
        var child = Entry("Child.esp");

        Assert.Equal([child.Key], Ready(Base(), (child, Content("BASE.ESM"))).Plugins);
    }

    [Fact]
    public void GetDependants_AnInactivePlugin_IsADependant_ForTheIndexHoldsEveryPluginOfTheInstance()
    {
        var child = Entry("Child.esp", enabled: false);

        Assert.Equal([child.Key], Ready(Base(), (child, Content("Base.esm"))).Plugins);
    }

    [Fact]
    public void GetDependants_ThePluginItself_IsNeverItsOwnDependant()
    {
        Assert.Empty(Ready((Entry("Base.esm", "BaseMod"), Content("Base.esm"))).Plugins);
    }

    [Fact]
    public void GetDependants_APluginWhoseMastersWereNotRead_IsUnreadable_ForItMayListTheName()
    {
        var unread = Entry("Unread.esp");

        var answer = Ready(Base(), (unread, null));

        Assert.Equal([unread.Key], answer.Unreadable);
        Assert.Empty(answer.Plugins);
    }

    [Theory]
    [InlineData(LoadOrderState.Reconciling)]
    [InlineData(LoadOrderState.Failed)]
    public void GetDependants_BeforeTheIndexIsReady_AnswersNothing_ForAPluginNotYetOpenedWouldReadAsNoDependant(LoadOrderState state)
    {
        Assert.Null(Ask(state, Base(), (Entry("Child.esp"), Content("Base.esm"))));
    }

    [Fact]
    public void GetDependants_WithNoLoadOrderHeld_Throws()
    {
        var service = new PluginDependantsQueryService(
            new FakeIndex(new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])), new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(() => service.GetDependants(Renamed));
    }
}
