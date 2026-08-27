using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>
/// #506's permanent gate, in <see cref="BinaryRoundTripGateTests"/>' (#369) shape: three real,
/// unrelated, override-heavy plugins whose stored <c>HEDR.NextObjectID</c> (and, it turned out,
/// <c>HEDR.NumRecords</c>) do <b>not</b> match what Mutagen's default write options
/// (<c>NextFormIDOption.Iterate</c>, <c>RecordCountOption.Iterate</c>) recompute on write. Nothing
/// in-game reads either field and authoring tools routinely leave them stale, so ADR-0042's
/// byte-fidelity target is the source's own stored value, verbatim — never a "more correct"
/// recompute. <see cref="CutDownPluginFixture"/> cannot expose this: it is itself Mutagen-written,
/// so its stored values already equal the recompute.
///
/// Each fixture recomputes <c>NextObjectID</c> through a different branch, which is why all three
/// stay. Checked in under space-free names (#510: git refuses a ref name with a space, so the
/// originals' own filenames would fail Track for an unrelated reason); a plugin's name is not part of
/// its bytes, so the fixtures are still the originals byte-for-byte:
/// <list type="bullet">
/// <item><c>LitR-SettingsHolotapesSorting.esp</c> ("LitR - Settings Holotapes Sorting.esp") — 13
/// overrides, zero self-authored, flat GRUPs; stored 2, recompute falls to
/// <c>GetDefaultInitialNextFormID</c> (0). NumRecords stored 16, recompute 18.</item>
/// <item><c>RecruitSierra.esl</c> — 114 overrides, zero self-authored, nested WRLD/QUST GRUPs; stored
/// 17098, same fallback (0). NumRecords stored 148, recompute 145.</item>
/// <item><c>HitechTrashcansToBOS.esp</c> ("Hitech Trashcans to BOS.esp") — 84 overrides plus one
/// self-authored CONT; stored 43, recompute takes the max-self-authored+1 branch (~0x19AC74)
/// instead. NumRecords stored 150, recompute 149.</item>
/// </list>
///
/// <para>Only the LitR fixture runs the full Track and Compile theories: the other two clear the
/// header (proven by <see cref="Save_OfARealPluginWithAStaleHeader_PreservesNextObjectIdAndNumRecords"/>)
/// and then hit #511 — a zlib-compressed NPC_ Mutagen re-deflates at its own level, and REFR
/// rotations of <c>-0.0</c> Mutagen writes as <c>+0.0</c> — which is a separate product decision.
/// Adding them to <see cref="TrackAndCompileFixtures"/> is #511's own regression test.</para>
/// </summary>
public sealed class StaleNextObjectIdRoundTripGateTests
{
    public static TheoryData<string, uint, uint> Fixtures => new()
    {
        { "LitR-SettingsHolotapesSorting.esp", 2, 16 },
        { "RecruitSierra.esl", 17098, 148 },
        { "HitechTrashcansToBOS.esp", 43, 150 },
    };

    public static TheoryData<string> TrackAndCompileFixtures => new() { "LitR-SettingsHolotapesSorting.esp" };

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

    [Theory]
    [MemberData(nameof(TrackAndCompileFixtures))]
    public async Task Compile_OfARealPluginWithAStaleHeader_ReproducesTheSourceBytes(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);
        var original = await File.ReadAllBytesAsync(scratch.PluginPath);
        await scratch.TrackAsync();

        var result = scratch.CompileService().Compile(scratch.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var compiled = await File.ReadAllBytesAsync(scratch.PluginPath);
        Assert.True(original.AsSpan().SequenceEqual(compiled),
            $"Compile diverges from the source: original {original.Length:N0} B vs compiled {compiled.Length:N0} B.");
    }

    /// <summary>
    /// #506 AC4: a record present in the recompiled output but absent from the original is named as
    /// such, instead of falling through to the header/container catch-all. Forged the way
    /// <c>TrackServiceTests.TrackAsync_WithARecordThatFailsToRoundTrip_RefusesAndCommitsNothing</c>
    /// forges its divergence: a genuine deserialize of the tree Track just wrote, then one extra NPC.
    /// </summary>
    [Fact]
    public async Task Track_WithAnExtraRecordInTheRecompiledPlugin_NamesThatRecord()
    {
        using var scratch = new TrackedScratch("LitR-SettingsHolotapesSorting.esp");
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

    /// <summary>One fixture copied into a scratch mod folder, loaded as a session — the shape
    /// <see cref="CompileRoundTripGateTests"/>' constructor builds, plus an empty stub for each of the
    /// fixture's masters: compile orders the written master list from the session's load order
    /// (#337/ADR-0038), which needs those names present, not their content.</summary>
    private sealed class TrackedScratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-stale-header-game-").FullName;
        private readonly SessionManager _sessions;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-stale-header-").FullName;
        public string PluginPath { get; }
        public PluginKey Plugin { get; }

        public TrackedScratch(string fileName)
        {
            PluginPath = Path.Combine(ModFolder, fileName);
            File.Copy(FixturePath(fileName), PluginPath);
            Plugin = new PluginKey(fileName, "FixtureMod");

            var inputs = new List<ExplicitPluginInput>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(fileName), PluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new ExplicitPluginInput(master.Master.FileName, stubPath, "Stubs", true));
                }
            }
            inputs.Add(new ExplicitPluginInput(fileName, PluginPath, Plugin.Origin!, true));

            _sessions = new SessionManager(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ISessionManager)_sessions).LoadExplicit(_gameDirectory, inputs, GameRelease.Fallout4);
        }

        public Task TrackAsync(Func<string, CancellationToken, Task<IFallout4Mod>>? deserialize = null) =>
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_sessions.Session!, Plugin.Origin!, SourcePreset.Edits, deserialize);

        public PluginCompileService CompileService() =>
            new(_sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

        public void Dispose()
        {
            _sessions.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
