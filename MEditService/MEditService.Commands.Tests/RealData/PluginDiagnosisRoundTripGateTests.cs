using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>Two real survey fixtures: one whose malformed PERK carries full identity at the top level, and
/// a Kind A defect (ADR-0006) carrying none, proving no identity is fabricated.</summary>
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

    // Stub masters come from the fixture's own declared list: Track's round-trip write needs the
    // names present, not their content.
    private sealed class RealFixtureScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-diagnosis-game-").FullName;
        private readonly LoadOrderSnapshot _loadOrder;
        private const string Origin = "DiagnosisFixtureMod";

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-diagnosis-mod-").FullName;

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
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(fixtureFileName, pluginPath, Origin, Slot: inputs.Count, Enabled: true, Winning: true));

            _loadOrder = new LoadOrderSnapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, SnapshotCopies.Of(inputs));
        }

        public Task<TrackResult> TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
                .TrackAsync(_loadOrder, [.. _loadOrder.Copies.Select(c => c.Key)], Origin, SourcePreset.Edits);

        public void Dispose()
        {
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
