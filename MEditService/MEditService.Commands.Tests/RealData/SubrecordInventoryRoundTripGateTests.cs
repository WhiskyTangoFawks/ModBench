using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.RealData;

public sealed class SubrecordInventoryRoundTripGateTests
{
    [Fact]
    public async Task TrackAsync_OfAShortRdatRegionPlugin_RefusesNamingTheRegionItsDroppedSignaturesAndTheDiagnosisOfTheMalformedSubrecord()
    {
        using var scratch = new ShortRdatScratch();

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("REGN", result.Message);
        Assert.Contains("01000800", result.Message);
        Assert.Contains("RDMP", result.Message);
        Assert.Contains("ANAM", result.Message);
        Assert.Contains("RDMO", result.Message);
        Assert.Contains("RDSA", result.Message);
        Assert.Contains("fixed-size-subrecord-short", result.Message);
        Assert.Contains("repairable (lossless)", result.Message);
        Assert.Contains("RDAT is 6 bytes; a REGN RDAT is always 8", result.Message);
        Assert.False(TestAdapters.Source().IsTracked(scratch.ModFolder));
    }

    private sealed class ShortRdatScratch : IDisposable
    {
        private readonly ScratchDirectory _gameDirectory = new("medit-shortrdat-game-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-shortrdat-");

        public ShortRdatScratch()
        {
            var plugin = ShortRdatRegionPlugin.Plugin;
            plugin.WriteInto(ModFolder);
            var pluginPath = Path.Combine(ModFolder, plugin.FileName);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(pluginPath, "ShortRdatMod", _gameDirectory);
        }

        public async Task<PluginTrack> TrackAsync() =>
            (await TrackEveryPluginOf.ModAsync(_loadOrder, "ShortRdatMod")).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
