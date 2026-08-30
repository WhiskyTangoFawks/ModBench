using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings.DI;
using Noggog.WorkEngine;

namespace MEditService.Tests.Edits;

/// <summary>
/// #520's Compile-side counterpart to <c>RealData/MasterPruningRoundTripGateTests</c>' Track
/// coverage: <see cref="PluginCompileService"/>'s own <c>writer.SaveFromModAsync</c> call hits the
/// identical <c>UnmappableFormIDException</c> shape (same <c>PluginWriter</c>/ADR-0038 write
/// defaults <c>TrackService.VerifyRoundTrip</c>'s scratch write uses), so it needs its own catch —
/// defense in depth for a mod folder tracked before this fix shipped, or one whose source tree was
/// hand-placed rather than produced by <c>TrackService.TrackAsync</c>.
///
/// <para><b>Why this bypasses <c>TrackService.TrackAsync</c>.</b> That gate now refuses
/// <c>SpaDia_AMR.esp</c> outright (the fixture in <c>MasterPruningRoundTripGateTests</c>), so a
/// normal Track can no longer produce a tracked mod folder to compile from. This fixture instead
/// calls the same two primitives <c>TrackAsync</c> itself calls — <c>TrackService.SerializeToPristineFiles</c>
/// and <c>SourceRepository.Track</c> — directly, skipping only <c>VerifyRoundTrip</c>'s own gate,
/// which is exactly the shape of a plugin that got tracked before #520 (or by hand).</para>
/// </summary>
public sealed class PluginCompileServiceMasterPruningTests : IDisposable
{
    private const string FixtureFileName = "SpaDia_AMR.esp";
    private const string Origin = "SpaDiaAMRCompileMod";

    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-520-compile-game-").FullName;
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-520-compile-mod-").FullName;
    private readonly LoadOrderMirror _mirror;
    private readonly PluginKey _plugin = new(FixtureFileName, Origin);

    public PluginCompileServiceMasterPruningTests()
    {
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "TestData", FixtureFileName);
        var pluginPath = Path.Combine(_modFolder, FixtureFileName);
        File.Copy(fixturePath, pluginPath);

        // Stub masters (content-free, name-only) so the load order can reconcile — mirrors
        // MasterPruningRoundTripGateTests' own PrunedMasterScratch.
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
        inputs.Add(new LoadOrderEntry(FixtureFileName, pluginPath, Origin, Slot: inputs.Count, Enabled: true, Winning: true));

        _mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)_mirror).Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);

        // Track directly (bypassing TrackService.TrackAsync's own #520 gate — see class doc comment).
        var deepParsed = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(FixtureFileName), pluginPath), GameRelease.Fallout4,
            LocalizedStrings.ForRead(_modFolder));
        var pristineFiles = TrackService.SerializeToPristineFiles(deepParsed, FixtureFileName, CancellationToken.None)
            .GetAwaiter().GetResult();
        SourceRepository.Track(_modFolder, SourcePreset.Edits, pristineFiles, new TrackProvenance(null, null, new Dictionary<string, string>()));
    }

    /// <summary>#520 AC (Compile half): a tracked source tree carrying this defect refuses at
    /// Compile too, naming the same record/master/#688 — never an unhandled
    /// <c>UnmappableFormIDException</c> escaping to a 500.</summary>
    [Fact]
    public void Compile_OfTheRealSpaDiaAMRFixtureTrackedBeforeTheFix_RefusesNamingTheQuestAndThePrunedMaster()
    {
        var compileService = new PluginCompileService(
            _mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

        var result = compileService.Compile(_plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", result.RefusalReason);
        Assert.Contains("DLCNukaWorld.esm", result.RefusalReason);
        Assert.Contains("Mutagen #688", result.RefusalReason);
    }

    public void Dispose()
    {
        _mirror.Dispose();
        try { Directory.Delete(_modFolder, recursive: true); } catch (IOException) { }
        try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
    }
}
