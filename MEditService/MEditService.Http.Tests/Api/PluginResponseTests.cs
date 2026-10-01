using MEditService.LoadOrder;
using MEditService.Queries;

namespace MEditService.Http.Tests.Api;

public sealed class PluginResponseTests
{
    private static PluginRow Row(bool isTracked = false, bool isBlueprint = false, int? loadOrderIndex = 0) =>
        new(new RegisteredPlugin("Fixture.esp", "FixtureMod", Path.Combine(Path.GetTempPath(), "no-such-mod", "Fixture.esp")),
            loadOrderIndex, IsImmutable: loadOrderIndex is null,
            new PluginContent(IsLight: false, IsMaster: false, IsBlueprint: isBlueprint, Masters: [], RecordCount: 1),
            MasterIssues: [], HasMatchingRecords: true, HasParseFailure: false, IsTracked: isTracked);

    [Fact]
    public void IsTracked_IsTheRowsFact_WithNoRepositoryOnDisk()
    {
        Assert.True(PluginResponse.Of(Row(isTracked: true)).IsTracked);
        Assert.False(PluginResponse.Of(Row(isTracked: false)).IsTracked);
    }

    [Fact]
    public void IsBlueprint_IsTheRowsFact()
    {
        Assert.True(PluginResponse.Of(Row(isBlueprint: true)).IsBlueprint);
        Assert.False(PluginResponse.Of(Row(isBlueprint: false)).IsBlueprint);
    }

    // ADR-0013 invariant 3: a plugin is in the load order exactly when the snapshot lists it as
    // active, and its place there is its load index.
    [Fact]
    public void InLoadOrder_AndLoadOrderIndex_AreTheActivePluginsPlace()
    {
        var active = PluginResponse.Of(Row(loadOrderIndex: 3));
        var inactive = PluginResponse.Of(Row(loadOrderIndex: null));

        Assert.Equal((true, 3), (active.InLoadOrder, active.LoadOrderIndex));
        Assert.Equal((false, (int?)null), (inactive.InLoadOrder, inactive.LoadOrderIndex));
    }
}
