using MEditService.LoadOrder;
using MEditService.Queries;

namespace MEditService.Http.Tests.Api;

public sealed class PluginResponseTests
{
    private static PluginRow Row(bool isTracked = false, bool isBlueprint = false) =>
        new(new RegisteredPlugin("Fixture.esp", "FixtureMod", Path.Combine(Path.GetTempPath(), "no-such-mod", "Fixture.esp"), 0, Enabled: true, Winning: true),
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
}
