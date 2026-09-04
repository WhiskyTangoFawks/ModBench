using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary><c>LitR - TrueStorms.esp</c> carries a REGN whose malformed 6-byte <c>RDAT</c> desyncs
/// Mutagen's reader, which silently drops every following subrecord (R2 in medit-repair.md).</summary>
public sealed class SubrecordInventoryRoundTripGateTests
{
    private const string FixtureFileName = "LitR - TrueStorms.esp";
    private static string FixturePath => Path.Combine(AppContext.BaseDirectory, "TestData", FixtureFileName);

    [Fact]
    public async Task TrackAsync_OfTheRealTrueStormsFixture_RefusesNamingTheRegionAndItsDroppedSignatures()
    {
        using var scratch = new TrueStormsScratch();

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync());

        Assert.Contains("REGN", ex.Message);
        Assert.Contains("001D2AF4", ex.Message);
        Assert.Contains("RDMP", ex.Message);
        Assert.Contains("ANAM", ex.Message);
        Assert.Contains("RDMO", ex.Message);
        Assert.Contains("RDSA", ex.Message);
        // The refusal carries the Kind B diagnosis for the same record, the cause of the drop with its
        // repair tail, not only the generic inventory loss.
        Assert.Contains("fixed-size-subrecord-short", ex.Message);
        Assert.Contains("repairable (lossless)", ex.Message);
        Assert.Contains("RDAT is 6 bytes; a REGN RDAT is always 8", ex.Message);
        Assert.DoesNotContain("header or a container's own structure", ex.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    // Empty stubs for the fixture's masters: Track's round-trip write needs the names present, not
    // their content.
    private sealed class TrueStormsScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-truestorms-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-truestorms-").FullName;

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
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(FixtureFileName, pluginPath, "TrueStormsMod", Slot: inputs.Count, Enabled: true, Winning: true));

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance).TrackAsync(_mirror.LoadOrder!, "TrueStormsMod", SourcePreset.Edits);

        public void Dispose()
        {
            _mirror.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
