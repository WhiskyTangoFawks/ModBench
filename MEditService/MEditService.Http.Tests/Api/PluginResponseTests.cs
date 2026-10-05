using MEditService.LoadOrder;
using MEditService.Queries;

namespace MEditService.Http.Tests.Api;

public sealed class PluginResponseTests
{
    private static PluginRow Row(bool isTracked = false, bool isBlueprint = false, int? loadOrderIndex = 0) =>
        new(new RegisteredPlugin(
            "Fixture.esp", "FixtureMod", Path.Combine(Path.GetTempPath(), "no-such-mod", "Fixture.esp"),
            new PluginProvider.FromMod("FixtureMod", Path.Combine(Path.GetTempPath(), "no-such-mod"))),
            loadOrderIndex, IsImmutable: loadOrderIndex is null,
            new PluginContent(IsLight: false, IsMaster: false, IsBlueprint: isBlueprint, Masters: [], RecordCount: 1, IsMedium: false),
            MasterIssues: [], HasMatchingRecords: true, HasParseFailure: false, IsTracked: isTracked);

    [Fact]
    public void InLoadOrder_AndLoadOrderIndex_AreTheActivePluginsPlace()
    {
        var active = PluginResponse.Of(Row(loadOrderIndex: 3));
        var inactive = PluginResponse.Of(Row(loadOrderIndex: null));

        Assert.Equal((true, 3), (active.InLoadOrder, active.LoadOrderIndex));
        Assert.Equal((false, (int?)null), (inactive.InLoadOrder, inactive.LoadOrderIndex));
    }
}
