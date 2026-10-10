using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.RealData;

public sealed class PluginDiagnosisRoundTripGateTests
{
    [Fact]
    public async Task TrackAsync_OfAMisshapedPerkPlugin_NamesThePerkRecordClassUnknown()
    {
        using var scratch = new RealFixtureScratch(MisshapedPerkPlugin.Plugin);

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("Perk", result.Message);
        Assert.Contains(MisshapedPerkPlugin.FormKey, result.Message);
        Assert.Contains(MisshapedPerkPlugin.EditorId, result.Message);
        Assert.Contains(PluginDiagnosis.UnknownClass, result.Message);
        Assert.False(TestAdapters.Source().IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfAMismatchedFnamPlugin_NamesOnlyThePluginWhenMutagenReportsNoRecordIdentity()
    {
        using var scratch = new RealFixtureScratch(MismatchedFnamPlugin.Plugin);

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("All FNAM strings should be the same", result.Message);
        Assert.DoesNotContain("EditorID", result.Message);
        Assert.DoesNotContain("FormKey", result.Message);
    }

    [Fact]
    public async Task TrackAsync_OfAMismatchedFnamPlugin_NamesTheUpstreamMutagenIssueInstead()
    {
        using var scratch = new RealFixtureScratch(MismatchedFnamPlugin.Plugin);

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("blocked upstream: Mutagen #687", result.Message);
        Assert.DoesNotContain($"— {PluginDiagnosis.UnknownClass}:", result.Message);
    }

    private sealed class RealFixtureScratch : IDisposable
    {
        private readonly ScratchDirectory _gameDirectory = new("medit-diagnosis-game-");
        private readonly LoadOrderSnapshot _loadOrder;
        private const string Origin = "DiagnosisFixtureMod";

        public ScratchDirectory ModFolder { get; } = new("medit-diagnosis-mod-");

        public RealFixtureScratch(GeneratedPlugin plugin)
        {
            plugin.WriteInto(ModFolder);
            var pluginPath = Path.Combine(ModFolder, plugin.FileName);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(pluginPath, Origin, _gameDirectory);
        }

        public async Task<PluginTrack> TrackAsync() =>
            (await TrackEveryPluginOf.ModAsync(_loadOrder, Origin)).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
