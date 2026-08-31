using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>
/// A permanent gate in <see cref="BinaryRoundTripGateTests"/>' shape: three real,
/// unrelated, override-heavy plugins whose stored <c>HEDR.NextObjectID</c> (and
/// <c>HEDR.NumRecords</c>) do <b>not</b> match what Mutagen's default write options
/// (<c>NextFormIDOption.Iterate</c>, <c>RecordCountOption.Iterate</c>) recompute on write. Nothing
/// in-game reads either field and authoring tools routinely leave them stale, so ADR-0042's
/// byte-fidelity target is the source's own stored value, verbatim — never a "more correct"
/// recompute. <see cref="CutDownPluginFixture"/> cannot expose this: it is itself Mutagen-written,
/// so its stored values already equal the recompute.
///
/// Each fixture recomputes <c>NextObjectID</c> through a different branch, which is why all three
/// stay. Checked in under their real filenames, spaces included — the LitR Track theory therefore
/// also exercises ref-name encoding on a real mod name:
/// <list type="bullet">
/// <item><c>LitR - Settings Holotapes Sorting.esp</c> — 13 overrides, zero self-authored, flat GRUPs;
/// stored 2, recompute falls to <c>GetDefaultInitialNextFormID</c> (0). NumRecords stored 16,
/// recompute 18.</item>
/// <item><c>RecruitSierra.esl</c> — 114 overrides, zero self-authored, nested WRLD/QUST GRUPs; stored
/// 17098, same fallback (0). NumRecords stored 148, recompute 145.</item>
/// <item><c>Hitech Trashcans to BOS.esp</c> — 84 overrides plus one self-authored CONT; stored 43,
/// recompute takes the max-self-authored+1 branch (~0x19AC74) instead. NumRecords stored 150,
/// recompute 149.</item>
/// </list>
///
/// <para>All three run the full Track and Compile theories. Two of them carry differences byte
/// identity would refuse — a zlib-compressed NPC_ Mutagen re-deflates at its own level, and REFR
/// rotations of <c>-0.0</c> Mutagen writes as <c>+0.0</c> — but ADR-0042 decision 2 makes the
/// round-trip verdict model identity: neither difference changes any record's own content, so both
/// fixtures Track and Compile successfully, and <see cref="Compile_OfARealPluginWithAStaleHeader_ReproducesTheSourceBytes"/>
/// asserts model identity between the original and compiled binaries rather than raw byte identity —
/// the compiled bytes are not expected to match the original's exactly for these two, only its
/// content.</para>
/// </summary>
public sealed class StaleNextObjectIdRoundTripGateTests
{
    public static TheoryData<string, uint, uint> Fixtures => new()
    {
        { "LitR - Settings Holotapes Sorting.esp", 2, 16 },
        { "RecruitSierra.esl", 17098, 148 },
        { "Hitech Trashcans to BOS.esp", 43, 150 },
    };

    public static TheoryData<string> TrackAndCompileFixtures => new()
    {
        "LitR - Settings Holotapes Sorting.esp",
        "RecruitSierra.esl",
        "Hitech Trashcans to BOS.esp",
    };

    private static string FixturePath(string fileName) => Path.Combine(AppContext.BaseDirectory, "TestData", fileName);

    /// <summary>
    /// The production save path (<see cref="PluginWriter.SaveAsync"/>, which shares
    /// <see cref="PluginWriter.PrepareFromModAsync"/> with Save &amp; Compile): the header's two
    /// stat fields come back exactly as stored. Red under Mutagen's defaults on every row — each
    /// stored value was chosen because the recompute disagrees with it.
    /// </summary>
    [Theory]
    [MemberData(nameof(Fixtures))]
    public async Task Save_OfARealPluginWithAStaleHeader_PreservesNextObjectIdAndNumRecords(
        string fileName, uint storedNextObjectId, uint storedNumRecords)
    {
        using var scratch = new TrackedScratch(fileName);
        Assert.Equal((storedNextObjectId, storedNumRecords), ReadHeaderStats(scratch.PluginPath));

        await new PluginWriter(NullLogger<PluginWriter>.Instance).SaveAsync(scratch.PluginPath, GameRelease.Fallout4);

        Assert.Equal((storedNextObjectId, storedNumRecords), ReadHeaderStats(scratch.PluginPath));
    }

    [Theory]
    [MemberData(nameof(TrackAndCompileFixtures))]
    public async Task Track_OfARealPluginWithAStaleHeader_Succeeds(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    /// <summary>
    /// Model identity, not byte identity, is Compile's own success bar here too — reusing
    /// <see cref="ModelIdentity"/>, the same shared checker <see cref="TrackService"/>'s gate calls.
    /// <c>LitR - Settings Holotapes Sorting.esp</c> still happens to compile back byte-for-byte (no
    /// such divergence in that fixture), so this is strictly a widening of what the theory
    /// accepts, not a weakening of what it checks for the fixture it already covered.
    /// </summary>
    [Theory]
    [MemberData(nameof(TrackAndCompileFixtures))]
    public async Task Compile_OfARealPluginWithAStaleHeader_ReproducesTheSourceContent(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);
        var original = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), scratch.PluginPath), Fallout4Release.Fallout4);
        await scratch.TrackAsync();

        var result = scratch.CompileService().Compile(scratch.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var compiled = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), scratch.PluginPath), Fallout4Release.Fallout4);
        var divergence = ModelIdentity.FindFirst(original, compiled);
        Assert.Null(divergence);
    }

    /// <summary>
    /// A record present in the recompiled output but absent from the original is named as
    /// such, instead of falling through to the header/container catch-all. Forged the way
    /// <c>TrackServiceTests.TrackAsync_WithARecordThatFailsToRoundTrip_RefusesAndCommitsNothing</c>
    /// forges its divergence: a genuine deserialize of the tree Track just wrote, then one extra NPC.
    /// </summary>
    [Fact]
    public async Task Track_WithAnExtraRecordInTheRecompiledPlugin_NamesThatRecord()
    {
        using var scratch = new TrackedScratch("LitR - Settings Holotapes Sorting.esp");
        FormKey? extra = null;

        async Task<IFallout4Mod> DeserializeThenAddAnNpc(string folder, CancellationToken ct)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            extra = deserialized.Npcs.AddNew("ExtraNpc").FormKey;
            return deserialized;
        }

        var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(() => scratch.TrackAsync(DeserializeThenAddAnNpc));

        Assert.Contains(extra!.Value.ToString(), ex.Message);
        Assert.Contains("ExtraNpc", ex.Message);
        Assert.Contains("not present in the original", ex.Message);
    }

    private static (uint NextObjectId, uint NumRecords) ReadHeaderStats(string pluginPath)
    {
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(Path.GetFileName(pluginPath)), pluginPath), Fallout4Release.Fallout4);
        return (overlay.ModHeader.Stats.NextFormID, overlay.ModHeader.Stats.NumRecords);
    }

    /// <summary>One fixture copied into a scratch mod folder, loaded as a load order — the shape
    /// <see cref="CompileRoundTripGateTests"/>' constructor builds, plus an empty stub for each of the
    /// fixture's masters: compile orders the written master list from the load order's load order
    /// (ADR-0038), which needs those names present, not their content.</summary>
    private sealed class TrackedScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-stale-header-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-stale-header-").FullName;
        public string PluginPath { get; }
        public PluginKey Plugin { get; }

        public TrackedScratch(string fileName)
        {
            PluginPath = Path.Combine(ModFolder, fileName);
            File.Copy(FixturePath(fileName), PluginPath);
            Plugin = new PluginKey(fileName, "FixtureMod");

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(fileName), PluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(fileName, PluginPath, Plugin.Origin!, Slot: inputs.Count, Enabled: true, Winning: true));

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync(Func<string, CancellationToken, Task<IFallout4Mod>>? deserialize = null) =>
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Plugin.Origin!, SourcePreset.Edits, deserialize);

        public PluginCompileService CompileService() =>
            new(_mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

        public void Dispose()
        {
            _mirror.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
