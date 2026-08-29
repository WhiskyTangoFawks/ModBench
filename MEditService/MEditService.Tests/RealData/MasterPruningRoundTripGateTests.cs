using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>
/// #563's own real fixture, in <see cref="SubrecordInventoryRoundTripGateTests"/>' (#514) shape: a
/// real, unrelated plugin whose own bytes trip <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>'s
/// pre-#563 false positive, not a forged one — recovered directly from the #513 LitR-instance survey
/// (<c>RoundTripSurvey</c>, <c>MEDIT_SURVEY_MODS=/home/wayne/Games/FO4/LitR/mods</c>), which named
/// 104 of its 684 plugins' Track refusals as exactly this shape.
///
/// <c>LitR - FaceGen/FaceGen Output.esp</c> is 82 bytes: one <c>TES4</c> header record declaring
/// <c>Fallout4.esm</c> as a master (<c>MAST</c>+<c>DATA</c>) but carrying zero records
/// (<c>HEDR.NumRecords</c> = 0) — nothing in the file ever references that master. ADR-0038's
/// unconditional, content-derived master-list write (Mutagen's default
/// <c>MastersListContentOption.Iterate</c>, the same default <c>PluginWriter</c> and every other write
/// path in this codebase rely on) therefore prunes it to zero masters on Track's own round-trip
/// verification write — a <c>TES4 MAST+DATA</c> byte difference that is sanctioned pruning, not a
/// dropped subrecord. Pre-#563, <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/> could not tell
/// the two apart and refused this plugin; this fixture is the smallest real one the LitR survey
/// produced that isolates exactly that one difference (a single pruned, wholly-unused master, no
/// other divergence in the file).
/// </summary>
public sealed class MasterPruningRoundTripGateTests
{
    private const string FixtureFileName = "FaceGen Output.esp";
    private static string FixturePath => Path.Combine(AppContext.BaseDirectory, "TestData", FixtureFileName);

    /// <summary>AC: Track accepts this real plugin despite the pruned, unused master — the false
    /// positive #563 exists to fix. Verified failing against the pre-#563 rival (no TES4 exemption):
    /// rerunning this exact test threw <c>SourceRoundTripFailedException: FaceGen Output.esp does not
    /// round-trip through its own tracked source: TES4 00000000 is missing MAST, DATA present in the
    /// original — dropped during parsing, before Track ever wrote its source.</c> — matching the
    /// survey's own CSV row for this exact fixture (<c>refuse:subrecord-loss:TES4:MAST+DATA</c>).
    /// Reverted; the shipped implementation (this test asserts) tracks it instead.</summary>
    [Fact]
    public async Task TrackAsync_OfTheRealFaceGenOutputFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new FaceGenScratch();

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>One real fixture copied into a scratch mod folder and loaded as a session — the same
    /// shape <see cref="SubrecordInventoryRoundTripGateTests"/>'s own <c>TrueStormsScratch</c> builds —
    /// with an empty stub for the fixture's one declared master (Track's round-trip write needs that
    /// name present in the header's own master list to satisfy the read, not its content; whether it
    /// survives the *write* back out is exactly what this fixture tests).</summary>
    private sealed class FaceGenScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-facegen-game-").FullName;
        private readonly SessionManager _sessions;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-facegen-").FullName;

        public FaceGenScratch()
        {
            var pluginPath = Path.Combine(ModFolder, FixtureFileName);
            File.Copy(FixturePath, pluginPath);

            var inputs = new List<ExplicitPluginInput>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(FixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new ExplicitPluginInput(master.Master.FileName, stubPath, "Stubs", true));
                }
            }
            inputs.Add(new ExplicitPluginInput(FixtureFileName, pluginPath, "FaceGenMod", true));

            _sessions = new SessionManager(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ISessionManager)_sessions).LoadExplicit(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance).TrackAsync(_sessions.Session!, "FaceGenMod", SourcePreset.Edits);

        public void Dispose()
        {
            _sessions.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
