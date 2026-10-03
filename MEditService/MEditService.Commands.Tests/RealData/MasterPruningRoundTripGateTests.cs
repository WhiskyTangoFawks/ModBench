using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

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

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(_fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var emptyMasterStubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(emptyMasterStubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, emptyMasterStubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(_fixtureFileName, pluginPath, _origin, Slot: inputs.Count, Enabled: true, Winning: true));

            _loadOrder = SnapshotPlugins.Snapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, inputs);
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
