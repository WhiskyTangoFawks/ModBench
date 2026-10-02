using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class RegionDataEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ARegionsWeatherOcclusionDistance_TakesASet()
    {
        var region = new Region(new FormKey(ModKey.FromFileName("DocEdit.esp"), 0x800), Fallout4Release.Fallout4)
        {
            Weather = new RegionWeather { LodDisplayDistanceMultiplier = 2, OcclusionAccuracyDist = 12 },
        };
        var formKey = _fixture.Seed(region, "regn");

        var (result, after) = _fixture.Apply(formKey, SetAt(JsonDocument.Parse("13").RootElement, Member("Weather"), Member("OcclusionAccuracyDist")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(13, JsonNode.Parse(after.Require()).Require()["Weather"].Require()["OcclusionAccuracyDist"].Require().GetValue<float>());
    }
}
