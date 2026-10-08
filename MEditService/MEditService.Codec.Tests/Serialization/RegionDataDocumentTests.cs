using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RegionDataDocumentTests
{

    private static Region RegionWithEveryDataEntry() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x800), Fallout4Release.Fallout4)
        {
            Objects = new RegionObjects { LodDisplayDistanceMultiplier = 1, OcclusionAccuracyDist = 11 },
            Weather = new RegionWeather { LodDisplayDistanceMultiplier = 2, OcclusionAccuracyDist = 12 },
            Map = new RegionMap { LodDisplayDistanceMultiplier = 3, OcclusionAccuracyDist = 13 },
            Land = new RegionLand { LodDisplayDistanceMultiplier = 4, OcclusionAccuracyDist = 14 },
            Grasses = new RegionGrasses { LodDisplayDistanceMultiplier = 5, OcclusionAccuracyDist = 15 },
            Sounds = new RegionSounds { LodDisplayDistanceMultiplier = 6, OcclusionAccuracyDist = 16 },
        };

    private static IEnumerable<string> MembersSpelledTwice(JsonElement element, string path) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject()
            .GroupBy(p => p.Name, StringComparer.Ordinal)
            .Where(g => g.Count() > 1)
            .Select(g => $"{path}.{g.Key}")
            .Concat(element.EnumerateObject().SelectMany(p => MembersSpelledTwice(p.Value, $"{path}.{p.Name}"))),
        JsonValueKind.Array => element.EnumerateArray().SelectMany((e, i) => MembersSpelledTwice(e, $"{path}[{i}]")),
        _ => [],
    };

    [Fact]
    public void ARegionsDataEntries_SpellEachMemberOnce()
    {
        using var document = JsonDocument.Parse(RecordTextCodec.SerializeToText(RegionWithEveryDataEntry(), GameRelease.Fallout4));

        Assert.Empty(MembersSpelledTwice(document.RootElement, "$"));
    }

    [Fact]
    public void ARegionsDataEntries_ReadBackWithTheirLodAndOcclusionValues()
    {
        var read = ReadBack.Of(RegionWithEveryDataEntry(), GameRelease.Fallout4, "regn");

        Assert.Equal(
            [(1f, 11f), (2f, 12f), (3f, 13f), (4f, 14f), (5f, 15f), (6f, 16f)],
            new[] { "Objects", "Weather", "Map", "Land", "Grasses", "Sounds" }
                .Select(entry => read.GetProperty(entry))
                .Select(d => (d.GetProperty("LodDisplayDistanceMultiplier").GetSingle(), d.GetProperty("OcclusionAccuracyDist").GetSingle())));
    }
}
