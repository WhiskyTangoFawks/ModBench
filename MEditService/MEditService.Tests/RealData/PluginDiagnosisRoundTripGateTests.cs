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
/// #519's diagnosis floor at Track's own deep-parse seam (<see cref="TrackService.TrackAsync(ILoadOrder, string, SourcePreset, System.Threading.CancellationToken)"/>'s
/// <c>ModFactory.ImportSetter</c> call), which had no try/catch at all before this ticket — any
/// Mutagen parse exception propagated raw, naming whatever survived in its own unlocated
/// <c>Message</c> (never <c>FormKey</c>/<c>EditorID</c> — those live only on <c>RecordException</c>'s
/// own <c>ToString()</c>, confirmed live while planning this ticket).
///
/// Two real fixtures, both found live against the 2026-08-27 LitR-instance survey (#513) while
/// planning this ticket — neither forged:
/// <list type="bullet">
/// <item><c>SKI_PlasmaAutocannon.esp</c>: a real, malformed PERK (<c>T6M_QuickReload_ReloadVATs</c>,
/// <c>0000EF:SKI_PlasmaAutocannon.esp</c>) whose entry-point parameter shape Mutagen's own parser
/// rejects — #569's own R7 territory (<c>docs/specs/medit-repair.md</c> names this exact fixture),
/// but until that detector exists this is <c>unknown</c> class. Mutagen's own
/// <c>SubrecordException</c> here carries full identity at the top level (no
/// <c>AggregateException</c> wrapping — the deeper, wrapped case is
/// <c>PluginDiagnosisTests.FromParseException_WalksNestedAggregateExceptionsForTheInnermostRecordException</c>'s
/// own job, built from a different real defect too large to commit as a fixture), proving the
/// "identity present" half of AC1.</item>
/// <item><c>Clipboards to the BOS.esp</c>: a real Kind A defect (ADR-0043) — a <c>MaterialSwap</c>
/// whose <c>FNAM</c> strings disagree, which Mutagen's own <c>RecordException</c> reports with
/// <b>no</b> FormKey/EditorID/RecordType at all (thrown from <c>FillBinaryFNAMParsingCustom</c>
/// before any record identity is attached) — proving the "identity genuinely absent, never
/// fabricated" half of AC1, and (<see cref="TrackAsync_OfClipboardsFixture_NamesTheUpstreamMutagenIssueInstead"/>)
/// the Kind A tail (AC2).</item>
/// </list>
/// </summary>
public sealed class PluginDiagnosisRoundTripGateTests
{
    /// <summary>AC1, identity-present half: the real PERK's own type, FormKey and EditorID all survive
    /// into the refusal, class <c>unknown</c> (no #569 detector exists yet to say more).</summary>
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

    /// <summary>AC1, identity-absent half: Mutagen's own exception here carries no record identity at
    /// all — the diagnosis must say so honestly (name the plugin, not a guessed record) rather than
    /// smearing in whatever <c>ToString()</c> would print for a null FormKey/EditorID.</summary>
    [Fact]
    public async Task TrackAsync_OfClipboardsFixture_NamesOnlyThePluginWhenMutagenReportsNoRecordIdentity()
    {
        using var scratch = new RealFixtureScratch("Clipboards to the BOS.esp");

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync());

        Assert.Contains("All FNAM strings should be the same", ex.Message);
        Assert.DoesNotContain("EditorID", ex.Message);
        Assert.DoesNotContain("FormKey", ex.Message);
    }

    /// <summary>AC2: this exact real Kind A defect is recognized by the small message-substring table
    /// and gets "blocked upstream: Mutagen #687" instead of the bare <c>unknown</c> class the previous
    /// test's own fixture would otherwise fall into — a real second pass over the same fixture, not a
    /// different one, proving the table actually intercepts before the fallback.</summary>
    [Fact]
    public async Task TrackAsync_OfClipboardsFixture_NamesTheUpstreamMutagenIssueInstead()
    {
        using var scratch = new RealFixtureScratch("Clipboards to the BOS.esp");

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync());

        Assert.Contains("blocked upstream: Mutagen #687", ex.Message);
        Assert.DoesNotContain($"— {PluginDiagnosis.UnknownClass}:", ex.Message);
    }

    /// <summary>One real, unrelated, malformed fixture copied into a scratch mod folder and loaded as
    /// a load order — the same shape <c>SubrecordInventoryRoundTripGateTests.TrueStormsScratch</c>
    /// builds, generalized over the fixture filename since this file needs it for two different real
    /// plugins rather than one. Stub masters are built generically from the fixture's own declared
    /// master list — Track's round-trip write needs those names present in the header's own master
    /// list, not their content.</summary>
    private sealed class RealFixtureScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-diagnosis-game-").FullName;
        private readonly LoadOrderMirror _mirror;
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

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance).TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits);

        public void Dispose()
        {
            _mirror.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
