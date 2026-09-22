using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.RealData;

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

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("REGN", result.Message);
        Assert.Contains("001D2AF4", result.Message);
        Assert.Contains("RDMP", result.Message);
        Assert.Contains("ANAM", result.Message);
        Assert.Contains("RDMO", result.Message);
        Assert.Contains("RDSA", result.Message);
        // The refusal carries the Kind B diagnosis for the same record, the cause of the drop with its
        // repair tail, not only the generic inventory loss.
        Assert.Contains("fixed-size-subrecord-short", result.Message);
        Assert.Contains("repairable (lossless)", result.Message);
        Assert.Contains("RDAT is 6 bytes; a REGN RDAT is always 8", result.Message);
        Assert.DoesNotContain("header or a container's own structure", result.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    // Empty stubs for the fixture's masters: Track's round-trip write needs the names present, not
    // their content.
    private sealed class TrueStormsScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-truestorms-game-").FullName;
        private readonly LoadOrderSnapshot _loadOrder;

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

            _loadOrder = new LoadOrderSnapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, SnapshotCopies.Of(inputs));
        }

        public Task<TrackResult> TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackAsync(_loadOrder, "TrueStormsMod", SourcePreset.Edits);

        public void Dispose()
        {
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
