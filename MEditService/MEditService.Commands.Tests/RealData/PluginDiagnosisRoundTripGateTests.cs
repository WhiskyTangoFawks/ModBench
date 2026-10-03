using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.RealData;

public sealed class PluginDiagnosisRoundTripGateTests
{
    [Fact]
    public async Task TrackAsync_OfPlasmaAutocannonFixture_NamesThePerkRecordClassUnknown()
    {
        using var scratch = new RealFixtureScratch("SKI_PlasmaAutocannon.esp");

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("Perk", result.Message);
        Assert.Contains("0000EF:SKI_PlasmaAutocannon.esp", result.Message);
        Assert.Contains("T6M_QuickReload_ReloadVATs", result.Message);
        Assert.Contains(PluginDiagnosis.UnknownClass, result.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfClipboardsFixture_NamesOnlyThePluginWhenMutagenReportsNoRecordIdentity()
    {
        using var scratch = new RealFixtureScratch("Clipboards to the BOS.esp");

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("All FNAM strings should be the same", result.Message);
        Assert.DoesNotContain("EditorID", result.Message);
        Assert.DoesNotContain("FormKey", result.Message);
    }

    [Fact]
    public async Task TrackAsync_OfClipboardsFixture_NamesTheUpstreamMutagenIssueInstead()
    {
        using var scratch = new RealFixtureScratch("Clipboards to the BOS.esp");

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

        public RealFixtureScratch(string fixtureFileName)
        {
            var fixturePath = Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName);
            var pluginPath = Path.Combine(ModFolder, fixtureFileName);
            File.Copy(fixturePath, pluginPath);

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var emptyMasterStubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(emptyMasterStubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, emptyMasterStubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(fixtureFileName, pluginPath, Origin, Slot: inputs.Count, Enabled: true, Winning: true));

            _loadOrder = SnapshotPlugins.Snapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, inputs);
        }

        public async Task<TrackResult> TrackAsync() =>
            (await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackModAsync(_loadOrder, Origin, SourcePreset.Edits)).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
