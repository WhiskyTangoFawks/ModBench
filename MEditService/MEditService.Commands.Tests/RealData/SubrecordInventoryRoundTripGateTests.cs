using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.RealData;

public sealed class SubrecordInventoryRoundTripGateTests
{
    private const string FixtureFileName = "LitR - TrueStorms.esp";
    private static string FixturePath => Path.Combine(AppContext.BaseDirectory, "TestData", FixtureFileName);

    [Fact]
    public async Task TrackAsync_OfTheRealTrueStormsFixture_RefusesNamingTheRegionItsDroppedSignaturesAndTheDiagnosisOfTheMalformedSubrecord()
    {
        using var scratch = new TrueStormsScratch();

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("REGN", result.Message);
        Assert.Contains("001D2AF4", result.Message);
        Assert.Contains("RDMP", result.Message);
        Assert.Contains("ANAM", result.Message);
        Assert.Contains("RDMO", result.Message);
        Assert.Contains("RDSA", result.Message);
        Assert.Contains("fixed-size-subrecord-short", result.Message);
        Assert.Contains("repairable (lossless)", result.Message);
        Assert.Contains("RDAT is 6 bytes; a REGN RDAT is always 8", result.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    private sealed class TrueStormsScratch : IDisposable
    {
        private readonly ScratchDirectory _gameDirectory = new("medit-truestorms-game-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-truestorms-");

        public TrueStormsScratch()
        {
            var pluginPath = Path.Combine(ModFolder, FixtureFileName);
            File.Copy(FixturePath, pluginPath);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(pluginPath, "TrueStormsMod", _gameDirectory);
        }

        public async Task<PluginTrack> TrackAsync() =>
            (await TrackEveryPluginOf.ModAsync(_loadOrder, "TrueStormsMod")).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
