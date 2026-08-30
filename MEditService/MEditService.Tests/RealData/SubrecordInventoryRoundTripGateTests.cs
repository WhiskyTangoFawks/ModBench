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

/// <summary>
/// #514's own real fixture, in <see cref="BinaryRoundTripGateTests"/>' (#369) shape: a real, unrelated
/// plugin whose own bytes trip <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>, not a forged one.
///
/// <c>LitR - TrueStorms.esp</c> (from the LitR modlist's "LitR - General Conflict Resolution Patches",
/// #513's 684-plugin survey) carries a REGN record, FormID <c>001D2AF4</c>, whose Map region-data entry
/// opens with a malformed 6-byte <c>RDAT</c> (the format's own fixed size is 8 — the 2 missing bytes are
/// unused pad; catalogued as R2 in <c>docs/specs/medit-repair.md</c>). Parsing that short subrecord
/// desyncs Mutagen's own reader, which then silently drops every subrecord that follows it in the
/// record: <c>RDMP</c> (the map's own path name), <c>ANAM</c>, and the entire Sound entry (<c>RDAT</c> +
/// <c>RDMO</c> + <c>RDSA</c>) — verified directly against this exact file (deep-parse, round-trip write,
/// hex-diff the record) while building this test; not the plugin's originally-suspected defect (a
/// literal second same-type <c>RDAT</c>, which <c>medit-repair.md</c> itself already retracts). Model
/// identity cannot see this: both the original parse and the recompiled-from-source parse already lost
/// the same bytes at parse time, so they agree with each other and disagree with the file on disk — only
/// a byte-level subrecord count comparison, run against the two *binaries*, can name it.
/// </summary>
public sealed class SubrecordInventoryRoundTripGateTests
{
    private const string FixtureFileName = "LitR - TrueStorms.esp";
    private static string FixturePath => Path.Combine(AppContext.BaseDirectory, "TestData", FixtureFileName);

    /// <summary>AC1: Track refuses this real plugin, naming the record and the dropped signatures —
    /// not silently accepted the way <see cref="ModelIdentity.FindFirst"/> alone would leave it
    /// (its own mask comparison sees no difference here, since both sides of it already lost the same
    /// bytes at parse time; only this byte-level check can name it).</summary>
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
        Assert.DoesNotContain("header or a container's own structure", ex.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>One real fixture copied into a scratch mod folder and loaded as a load order — the same
    /// shape <c>StaleNextObjectIdRoundTripGateTests.TrackedScratch</c> builds — with an empty stub for
    /// each of the fixture's own masters (Track's round-trip write needs those names present in the
    /// header's own master list, not their content).</summary>
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
