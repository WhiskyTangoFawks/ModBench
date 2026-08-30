using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.RealData;

/// <summary>
/// #563's and #567's real fixtures, in <see cref="SubrecordInventoryRoundTripGateTests"/>' (#514)
/// shape: real, unrelated plugins whose own bytes trip
/// <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>' pre-#563 false positive, not forged ones.
///
/// <para><b>The shared mechanism.</b> ADR-0038 makes a plugin's masters wholly content-derived:
/// Mutagen's default <c>MastersListContentOption.Iterate</c> (the same default <c>PluginWriter</c> and
/// every other write path in this codebase rely on) rebuilds the outgoing master list from the live
/// object graph on every write, so a declared-but-never-referenced master is *pruned*, unconditionally
/// — "Clean is inherent to every compile", never a separate operation. Track's own round-trip
/// verification write is no exception, so any plugin declaring an unused master differs from its own
/// rewrite by exactly a <c>TES4 MAST</c>+<c>DATA</c> pair. That is sanctioned pruning, not a dropped
/// subrecord, and pre-#563 <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/> could not tell the two
/// apart — it refused every such plugin (72% of all real Track refusals across the #513 LitR-instance
/// survey's 684 plugins: <c>RoundTripSurvey</c>, <c>MEDIT_SURVEY_MODS=/home/wayne/Games/FO4/LitR/mods</c>).
/// Both fixtures below are recovered from that survey and both must Track.</para>
///
/// <para><b>#563 — <c>LitR - FaceGen/FaceGen Output.esp</c>, the total prune.</b> 82 bytes: one
/// <c>TES4</c> header record declaring <c>Fallout4.esm</c> as a master (<c>MAST</c>+<c>DATA</c>) but
/// carrying zero records (<c>HEDR.NumRecords</c> = 0), so nothing in the file ever references that
/// master and the rewrite prunes the list to empty (1 → 0). The smallest real fixture the survey
/// produced that isolates exactly one difference — a single pruned, wholly-unused master, nothing else
/// divergent in the file.</para>
///
/// <para><b>#567 — <c>Legendaries They Can Use/LegendariesTheyCanUse.esp</c>, the partial prune.</b>
/// 68KB, 71 records, ESL-flagged (<c>TES4</c> flags <c>0x200</c> =
/// <see cref="Fallout4ModHeader.HeaderFlag.Small"/>), declaring four masters —
/// <c>Fallout4.esm</c>, <c>DLCRobot.esm</c>, <c>DLCCoast.esm</c>, <c>DLCNukaWorld.esm</c> — of which
/// its content references only three: nothing anywhere in the file names a <c>DLCRobot.esm</c> record.
/// The rewrite prunes that one master out of the middle of the list (4 → 3) and renumbers every
/// remaining FormID's local master index around the hole (<c>DLCCoast</c> 2 → 1, <c>DLCNukaWorld</c>
/// 3 → 2). That renumbering is invisible to <see cref="ModelIdentity"/>, which compares by
/// <c>FormKey</c> (ModKey-based, not index-based), so the round trip is model-identical and Track must
/// accept it. This is a materially different case from #563's: a prune *within* a populated list
/// rather than the collapse of a one-entry one, on a file with real content to renumber. It is also a
/// real-world instance of the exact pattern ADR-0038 named and decided against (#283 — declaring an
/// otherwise-unused plugin as a master purely to pin load order, which this codebase does not support;
/// the prune is the decision, not a defect).</para>
///
/// <para><b>#567 was a stale repro.</b> The ticket reported this plugin refused with the message
/// below and hypothesised a parse-time drop in either Mutagen's binary reader or
/// <c>Mutagen.Bethesda.Serialization</c>. Both were refuted by isolated repro:
/// <c>ModFactory.ImportSetter</c> alone keeps all four masters, and so does the serialize/deserialize
/// round trip — the difference is introduced by the *write*, exactly as #563 already established. The
/// <c>/manual-test</c> that filed it ran the same day #563 merged, against a build that predated it.
/// <see cref="DeepParse_OfTheRealLegendariesFixture_KeepsEveryDeclaredMasterIncludingTheUnreferencedOne"/>
/// is that isolated repro made permanent, so the distinction survives without re-running the
/// investigation.</para>
/// </summary>
public sealed class MasterPruningRoundTripGateTests
{
    private const string FaceGenFixtureFileName = "FaceGen Output.esp";
    private const string LegendariesFixtureFileName = "LegendariesTheyCanUse.esp";

    private static string PathTo(string fixtureFileName) =>
        Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName);

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
        using var scratch = new PrunedMasterScratch(FaceGenFixtureFileName, "FaceGenMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>#567 AC3, the partial-prune counterpart to the fixture above: Track accepts this real
    /// plugin even though the rewrite prunes one master from the middle of a four-entry list and
    /// renumbers the survivors' FormID master indices around it. Verified failing against the same
    /// pre-#563 rival (the two-line TES4 <c>MAST</c>/<c>DATA</c> exemption deleted from
    /// <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>), which reproduces #567's reported message
    /// verbatim: <c>SourceRoundTripFailedException: LegendariesTheyCanUse.esp does not round-trip
    /// through its own tracked source: TES4 00000000 is missing MAST, DATA present in the original —
    /// dropped during parsing, before Track ever wrote its source.</c> Reverted.</summary>
    [Fact]
    public async Task TrackAsync_OfTheRealLegendariesFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new PrunedMasterScratch(LegendariesFixtureFileName, "LegendariesMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>#567 AC1, permanently pinned: the deep parse Track actually uses
    /// (<c>ModFactory.ImportSetter</c>, <c>TrackService</c>'s own reader) keeps all four declared
    /// masters, including the one no record references — so the <c>MAST</c>/<c>DATA</c> difference the
    /// gate sees downstream is introduced by the *write*, never lost on the way in. This is the single
    /// observation that separates "sanctioned pruning" from a genuine parse-time subrecord drop, and it
    /// is asserted here without any round trip so it stays decisive: should Mutagen ever really drop a
    /// well-formed <c>MAST</c>/<c>DATA</c> pair at parse time, this fails while the two Track tests
    /// above still pass (their gate exempts exactly that signature pair, and so cannot notice).</summary>
    [Fact]
    public void DeepParse_OfTheRealLegendariesFixture_KeepsEveryDeclaredMasterIncludingTheUnreferencedOne()
    {
        var fixturePath = PathTo(LegendariesFixtureFileName);
        var deepParsed = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(LegendariesFixtureFileName), fixturePath),
            GameRelease.Fallout4,
            LocalizedStrings.ForRead(Path.GetDirectoryName(fixturePath)!));

        Assert.Equal(
            ["Fallout4.esm", "DLCRobot.esm", "DLCCoast.esm", "DLCNukaWorld.esm"],
            deepParsed.MasterReferences.Select(master => master.Master.FileName.String));

        // ...and the rewrite prunes DLCRobot.esm precisely because nothing in the file names it: no
        // record of its own, and no link out of any other record. The other three are all referenced,
        // so they survive — this is content-derived pruning (ADR-0038), not indiscriminate.
        var referenced = deepParsed.EnumerateMajorRecords().Select(record => record.FormKey.ModKey)
            .Concat(deepParsed.EnumerateFormLinks().Select(link => link.FormKey.ModKey))
            .ToHashSet();

        Assert.DoesNotContain(ModKey.FromFileName("DLCRobot.esm"), referenced);
        Assert.Contains(ModKey.FromFileName("Fallout4.esm"), referenced);
        Assert.Contains(ModKey.FromFileName("DLCCoast.esm"), referenced);
        Assert.Contains(ModKey.FromFileName("DLCNukaWorld.esm"), referenced);
    }

    /// <summary>One real fixture copied into a scratch mod folder and loaded as a session — the same
    /// shape <see cref="SubrecordInventoryRoundTripGateTests"/>'s own <c>TrueStormsScratch</c> builds —
    /// with an empty stub for each of the fixture's declared masters (Track's round-trip write needs
    /// those names present in the header's own master list to satisfy the read, not their content;
    /// which of them survive the *write* back out is exactly what these fixtures test).</summary>
    private sealed class PrunedMasterScratch : IDisposable
    {
        private readonly string _fixtureFileName;
        private readonly string _origin;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-masterprune-game-").FullName;
        private readonly SessionManager _sessions;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-masterprune-").FullName;

        public PrunedMasterScratch(string fixtureFileName, string origin)
        {
            _fixtureFileName = fixtureFileName;
            _origin = origin;

            var pluginPath = Path.Combine(ModFolder, _fixtureFileName);
            File.Copy(PathTo(_fixtureFileName), pluginPath);

            var inputs = new List<ExplicitPluginInput>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(_fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new ExplicitPluginInput(master.Master.FileName, stubPath, "Stubs", true));
                }
            }
            inputs.Add(new ExplicitPluginInput(_fixtureFileName, pluginPath, _origin, true));

            _sessions = new SessionManager(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ISessionManager)_sessions).LoadExplicit(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance).TrackAsync(_sessions.Session!, _origin, SourcePreset.Edits);

        public void Dispose()
        {
            _sessions.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
