using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>
/// Real, unrelated plugins whose own bytes trip
/// <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>' master-pruning false positive, not forged
/// ones — <see cref="SubrecordInventoryRoundTripGateTests"/>' shape.
///
/// <para><b>The shared mechanism.</b> ADR-0038 makes a plugin's masters wholly content-derived:
/// Mutagen's default <c>MastersListContentOption.Iterate</c> (the same default <c>PluginWriter</c> and
/// every other write path in this codebase rely on) rebuilds the outgoing master list from the live
/// object graph on every write, so a declared-but-never-referenced master is *pruned*, unconditionally
/// — "Clean is inherent to every compile", never a separate operation. Track's own round-trip
/// verification write is no exception, so any plugin declaring an unused master differs from its own
/// rewrite by exactly a <c>TES4 MAST</c>+<c>DATA</c> pair. That is sanctioned pruning, not a dropped
/// subrecord; a walk that cannot tell the two apart refuses every such plugin (72% of all real Track
/// refusals across the LitR-instance survey's 684 plugins: <c>RoundTripSurvey</c>,
/// <c>MEDIT_SURVEY_MODS=/home/wayne/Games/FO4/LitR/mods</c>).
/// The first two fixtures below are recovered from that survey and both must Track.</para>
///
/// <para><b><c>LitR - FaceGen/FaceGen Output.esp</c>, the total prune.</b> 82 bytes: one
/// <c>TES4</c> header record declaring <c>Fallout4.esm</c> as a master (<c>MAST</c>+<c>DATA</c>) but
/// carrying zero records (<c>HEDR.NumRecords</c> = 0), so nothing in the file ever references that
/// master and the rewrite prunes the list to empty (1 → 0). The smallest real fixture the survey
/// produced that isolates exactly one difference — a single pruned, wholly-unused master, nothing else
/// divergent in the file.</para>
///
/// <para><b><c>Legendaries They Can Use/LegendariesTheyCanUse.esp</c>, the partial prune.</b>
/// 68KB, 71 records, ESL-flagged (<c>TES4</c> flags <c>0x200</c> =
/// <see cref="Fallout4ModHeader.HeaderFlag.Small"/>), declaring four masters —
/// <c>Fallout4.esm</c>, <c>DLCRobot.esm</c>, <c>DLCCoast.esm</c>, <c>DLCNukaWorld.esm</c> — of which
/// its content references only three: nothing anywhere in the file names a <c>DLCRobot.esm</c> record.
/// The rewrite prunes that one master out of the middle of the list (4 → 3) and renumbers every
/// remaining FormID's local master index around the hole (<c>DLCCoast</c> 2 → 1, <c>DLCNukaWorld</c>
/// 3 → 2). That renumbering is invisible to <see cref="ModelIdentity"/>, which compares by
/// <c>FormKey</c> (ModKey-based, not index-based), so the round trip is model-identical and Track must
/// accept it. This is a materially different case from the total prune: a prune *within* a populated
/// list rather than the collapse of a one-entry one, on a file with real content to renumber. It is
/// also a real-world instance of the exact pattern ADR-0038 named and decided against (declaring an
/// otherwise-unused plugin as a master purely to pin load order, which this codebase does not support;
/// the prune is the decision, not a defect).</para>
///
/// <para><b>Suite placement.</b> <see cref="SubrecordInventoryRoundTripGateTests"/> exists to prove
/// Track <i>refuses</i> a genuine parse-time subrecord drop; this suite exists to prove Track
/// <i>accepts</i> ADR-0038's sanctioned master pruning. The two suites assert opposite polarities,
/// and the partial-prune fixture belongs beside the total-prune fixture it is the direct counterpart
/// to.</para>
///
/// <para><b><c>SpaDia_AMR.esp</c> (Rat Runners Arsenal), the shape none of the above can
/// accept.</b> Its Quest <c>DiaQ_LLInjector_SpadeyAMR</c> (<c>0000DD</c>) references
/// <c>DLCNukaWorld.esm</c> only from inside a VMAD <c>ScriptStructListProperty</c>
/// (<c>DLC04:DLCLegendaryLLManagerScript</c>'s <c>LeveledListData</c>) — the FormLink lives on a
/// struct member (<c>ListToUpdate</c>/<c>FormToAdd</c>, both <c>ScriptObjectProperty</c>) that
/// Mutagen's own <c>ScriptStructListProperty.EnumerateFormLinks</c> never walks
/// (Mutagen-Modding/Mutagen#688; <see cref="ScriptStructListPropertyLinkGapTests"/> pins the
/// mechanism). Unlike the two prune fixtures, this is not sanctioned pruning: the master really is
/// used, Mutagen simply cannot see the use, so the content-derived write prunes it anyway and then
/// cannot write the property's own FormID (<c>UnmappableFormIDException</c>). Refused, not accepted —
/// the shape Kind A defects get (<c>PluginDiagnosis.KindATable</c>'s Mutagen-#688 row), never a
/// silent <c>NoCheck</c> fallback.</para>
/// </summary>
public sealed class MasterPruningRoundTripGateTests
{
    private const string FaceGenFixtureFileName = "FaceGen Output.esp";
    private const string LegendariesFixtureFileName = "LegendariesTheyCanUse.esp";
    private const string SpaDiaAmrFixtureFileName = "SpaDia_AMR.esp";

    /// <summary>What <c>LegendariesTheyCanUse.esp</c>'s own TES4 header declares, in file order.</summary>
    private static readonly string[] DeclaredMasters =
        ["Fallout4.esm", "DLCRobot.esm", "DLCCoast.esm", "DLCNukaWorld.esm"];

    /// <summary>The same list minus <c>DLCRobot.esm</c>, the one no record in the file references —
    /// what ADR-0038's content-derived write leaves behind.</summary>
    private static readonly string[] MastersSurvivingThePrune =
        ["Fallout4.esm", "DLCCoast.esm", "DLCNukaWorld.esm"];

    private static string PathTo(string fixtureFileName) =>
        Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName);

    /// <summary>Track accepts this real plugin despite the pruned, unused master. Without the TES4
    /// exemption in <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>, this throws
    /// <c>SourceRoundTripFailedException: FaceGen Output.esp does not round-trip through its own
    /// tracked source: TES4 00000000 is missing MAST, DATA present in the original — dropped during
    /// parsing, before Track ever wrote its source.</c></summary>
    [Fact]
    public async Task TrackAsync_OfTheRealFaceGenOutputFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new PrunedMasterScratch(FaceGenFixtureFileName, "FaceGenMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>The partial-prune counterpart to the fixture above: Track accepts this real
    /// plugin even though the rewrite prunes one master from the middle of a four-entry list and
    /// renumbers the survivors' FormID master indices around it. With the TES4 <c>MAST</c>/<c>DATA</c>
    /// exemption deleted from <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>, this fails:
    /// <c>SourceRoundTripFailedException: LegendariesTheyCanUse.esp does not round-trip
    /// through its own tracked source: TES4 00000000 is missing MAST, DATA present in the original —
    /// dropped during parsing, before Track ever wrote its source.</c></summary>
    [Fact]
    public async Task TrackAsync_OfTheRealLegendariesFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new PrunedMasterScratch(LegendariesFixtureFileName, "LegendariesMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>Unlike the two tests above, Track refuses this real plugin — the
    /// master really is referenced (Mutagen just can't see it, Mutagen #688), so pruning it is not
    /// sanctioned and the write cannot complete. The diagnosis names the record, the pruned master,
    /// and cites Mutagen #688 as the known cause of this shape; no exception escapes to a 500 (a bare
    /// <see cref="SourceRoundTripFailedException"/>, never <c>UnmappableFormIDException</c> itself).</summary>
    [Fact]
    public async Task TrackAsync_OfTheRealSpaDiaAMRFixture_RefusesNamingTheQuestAndThePrunedMaster()
    {
        using var scratch = new PrunedMasterScratch(SpaDiaAmrFixtureFileName, "SpaDiaAMRMod");

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync());

        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", ex.Message);
        Assert.Contains("DLCNukaWorld.esm", ex.Message);
        Assert.Contains("Mutagen #688", ex.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>The deep parse Track actually uses
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
        var deepParsed = DeepParseLegendaries();

        Assert.Equal(DeclaredMasters, deepParsed.MasterReferences.Select(master => master.Master.FileName.String));

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

    /// <summary>The counterpart to the test above: the whole-mod
    /// serialize/deserialize round trip through <c>Mutagen.Bethesda.Serialization</c> — a different
    /// package from the binary reader — keeps all
    /// four declared masters too. Together the two tests place the <c>MAST</c>/<c>DATA</c> difference
    /// squarely at the write and nowhere earlier, which is the whole finding. Asserted on the model
    /// straight out of <c>DeserializeWholeMod</c>, before any binary write touches it, for the same
    /// reason the parse test asserts before any round trip: should this round trip ever genuinely drop a
    /// master, nothing else in this file would notice — the two Track tests' gate exempts exactly this
    /// signature pair, and the write-side test below expects the master gone by then anyway.</summary>
    [Fact]
    public async Task SourceRoundTrip_OfTheRealLegendariesFixture_KeepsEveryDeclaredMaster()
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-masterprune-source-").FullName;
        try
        {
            var fromSource = await DeserializeLegendariesThroughSource(scratchDir);

            Assert.Equal(DeclaredMasters, fromSource.MasterReferences.Select(master => master.Master.FileName.String));
        }
        finally { Directory.Delete(scratchDir, recursive: true); }
    }

    /// <summary>The mechanism, asserted rather than merely described: it is the *write* that
    /// prunes, and it prunes exactly <c>DLCRobot.esm</c> — the one master no record references — leaving
    /// the other three in their original relative order. The two Track tests above can only report a
    /// bool; this names what actually happens to the header, so a future change that pruned the wrong
    /// master, pruned too many, or reordered the survivors would still satisfy them but fail here.
    /// Reproduces <c>TrackService.VerifyRoundTrip</c>'s own verification write option for option
    /// (<c>WithLoadOrderFromHeaderMasters</c>/<c>WithNoDataFolder</c>/<c>NoNextFormIDProcessing</c>/
    /// <c>RecordCountOption.NoCheck</c>) because that scratch write is deleted before Track returns —
    /// the same "reproduce the original's own bytes" shape <c>BinaryRoundTripGateTests</c> already
    /// establishes.</summary>
    [Fact]
    public async Task SourceRoundTripWrite_OfTheRealLegendariesFixture_PrunesOnlyTheUnreferencedMaster()
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-masterprune-write-").FullName;
        try
        {
            var fromSource = await DeserializeLegendariesThroughSource(scratchDir);
            var rewrittenPath = Path.Combine(scratchDir, LegendariesFixtureFileName);
            await fromSource.BeginWrite
                .ToPath(rewrittenPath)
                .WithLoadOrderFromHeaderMasters()
                .WithNoDataFolder()
                .NoNextFormIDProcessing()
                .WithRecordCount(RecordCountOption.NoCheck)
                .WriteAsync();

            var rewritten = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName(LegendariesFixtureFileName), rewrittenPath), Fallout4Release.Fallout4);

            Assert.Equal(
                MastersSurvivingThePrune,
                rewritten.ModHeader.MasterReferences.Select(master => master.Master.FileName.String));
        }
        finally { Directory.Delete(scratchDir, recursive: true); }
    }

    /// <summary>The fixture through Track's own reader — <c>ModFactory.ImportSetter</c>, the deep parse,
    /// not the load order's lazy overlay.</summary>
    private static IMod DeepParseLegendaries()
    {
        var fixturePath = PathTo(LegendariesFixtureFileName);
        return ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(LegendariesFixtureFileName), fixturePath),
            GameRelease.Fallout4,
            LocalizedStrings.ForRead(Path.GetDirectoryName(fixturePath)!));
    }

    /// <summary>The fixture all the way through Track's source pipeline and back — deep parse, whole-mod
    /// serialize to a pristine tree, write that tree to <paramref name="scratchDir"/>, deserialize it —
    /// stopping short of the binary write, which the two callers differ on.</summary>
    private static async Task<IFallout4Mod> DeserializeLegendariesThroughSource(string scratchDir)
    {
        var pristineFiles = await TrackService.SerializeToPristineFiles(DeepParseLegendaries(), LegendariesFixtureFileName);
        await PristineFileWriter.WriteAllAsync(pristineFiles, scratchDir, CancellationToken.None);

        return await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            Path.Combine(scratchDir, SourceRecordPath.RootFor(LegendariesFixtureFileName)),
            InlineWorkDropoff.Instance,
            CancellationToken.None);
    }

    /// <summary>One real fixture copied into a scratch mod folder and reconciled into a load order — the same
    /// shape <see cref="SubrecordInventoryRoundTripGateTests"/>'s own <c>TrueStormsScratch</c> builds —
    /// with an empty stub for each of the fixture's declared masters (Track's round-trip write needs
    /// those names present in the header's own master list to satisfy the read, not their content;
    /// which of them survive the *write* back out is exactly what these fixtures test).</summary>
    private sealed class PrunedMasterScratch : IDisposable
    {
        private readonly string _fixtureFileName;
        private readonly string _origin;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-masterprune-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-masterprune-").FullName;

        public PrunedMasterScratch(string fixtureFileName, string origin)
        {
            _fixtureFileName = fixtureFileName;
            _origin = origin;

            var pluginPath = Path.Combine(ModFolder, _fixtureFileName);
            File.Copy(PathTo(_fixtureFileName), pluginPath);

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(_fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(_fixtureFileName, pluginPath, _origin, Slot: inputs.Count, Enabled: true, Winning: true));

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance).TrackAsync(_mirror.LoadOrder!, _origin, SourcePreset.Edits);

        public void Dispose()
        {
            _mirror.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
