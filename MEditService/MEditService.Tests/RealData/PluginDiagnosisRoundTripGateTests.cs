using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>Two real survey fixtures: one whose malformed PERK carries full identity at the top level, and
/// a Kind A defect (ADR-0043) carrying none, proving no identity is fabricated.</summary>
public sealed class PluginDiagnosisRoundTripGateTests
{
    [Fact]
    public async Task TrackAsync_OfPlasmaAutocannonFixture_NamesThePerkRecordClassUnknown()
    {
        using var scratch = new RealFixtureScratch("SKI_PlasmaAutocannon.esp");

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync());

        Assert.Contains("Perk", ex.Message);
        Assert.Contains("0000EF:SKI_PlasmaAutocannon.esp", ex.Message);
        Assert.Contains("T6M_QuickReload_ReloadVATs", ex.Message);
        Assert.Contains(PluginDiagnosis.UnknownClass, ex.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfClipboardsFixture_NamesOnlyThePluginWhenMutagenReportsNoRecordIdentity()
    {
        using var scratch = new RealFixtureScratch("Clipboards to the BOS.esp");

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync());

        Assert.Contains("All FNAM strings should be the same", ex.Message);
        Assert.DoesNotContain("EditorID", ex.Message);
        Assert.DoesNotContain("FormKey", ex.Message);
    }

    [Fact]
    public async Task TrackAsync_OfClipboardsFixture_NamesTheUpstreamMutagenIssueInstead()
    {
        using var scratch = new RealFixtureScratch("Clipboards to the BOS.esp");

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync());

        Assert.Contains("blocked upstream: Mutagen #687", ex.Message);
        Assert.DoesNotContain($"— {PluginDiagnosis.UnknownClass}:", ex.Message);
    }

    // Stub masters come from the fixture's own declared list: Track's round-trip write needs the
    // names present, not their content.
    private sealed class RealFixtureScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-diagnosis-game-").FullName;
        private readonly IndexProjector _index;
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

            _index = new IndexProjector(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            _index.Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance).TrackAsync(_index.LoadOrder!, Origin, SourcePreset.Edits);

        public void Dispose()
        {
            _index.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
