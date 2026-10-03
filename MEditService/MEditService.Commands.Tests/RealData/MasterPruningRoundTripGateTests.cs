using MEditService.Commands.Tests.TestSupport;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Commands.Tests.RealData;

public sealed class MasterPruningRoundTripGateTests
{
    private const string FaceGenFixtureFileName = "FaceGen Output.esp";
    private const string LegendariesFixtureFileName = "LegendariesTheyCanUse.esp";
    private const string SpaDiaAmrFixtureFileName = "SpaDia_AMR.esp";

    private static string PathTo(string fixtureFileName) =>
        Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName);

    [Fact]
    public async Task TrackAsync_OfTheRealFaceGenOutputFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new PrunedMasterScratch(FaceGenFixtureFileName, "FaceGenMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfTheRealLegendariesFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new PrunedMasterScratch(LegendariesFixtureFileName, "LegendariesMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfTheRealSpaDiaAMRFixture_RefusesNamingTheQuestAndThePrunedMaster()
    {
        using var scratch = new PrunedMasterScratch(SpaDiaAmrFixtureFileName, "SpaDiaAMRMod");

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", result.Message);
        Assert.Contains("DLCNukaWorld.esm", result.Message);
        Assert.Contains("Mutagen #688", result.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    private sealed class PrunedMasterScratch : IDisposable
    {
        private readonly string _fixtureFileName;
        private readonly string _origin;
        private readonly ScratchDirectory _gameDirectory = new("medit-masterprune-game-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-masterprune-");

        public PrunedMasterScratch(string fixtureFileName, string origin)
        {
            _fixtureFileName = fixtureFileName;
            _origin = origin;

            var pluginPath = Path.Combine(ModFolder, _fixtureFileName);
            File.Copy(PathTo(_fixtureFileName), pluginPath);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(pluginPath, _origin, _gameDirectory);
        }

        public async Task<TrackResult> TrackAsync() =>
            (await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackModAsync(_loadOrder, _origin, SourcePreset.Edits)).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
