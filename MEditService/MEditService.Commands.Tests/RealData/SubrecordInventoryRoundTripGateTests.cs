using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

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

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(FixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var emptyMasterStubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(emptyMasterStubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, emptyMasterStubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(FixtureFileName, pluginPath, "TrueStormsMod", Slot: inputs.Count, Enabled: true, Winning: true));

            _loadOrder = SnapshotPlugins.Snapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, inputs);
        }

        public async Task<TrackResult> TrackAsync() =>
            (await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackModAsync(_loadOrder, "TrueStormsMod", SourcePreset.Edits)).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
