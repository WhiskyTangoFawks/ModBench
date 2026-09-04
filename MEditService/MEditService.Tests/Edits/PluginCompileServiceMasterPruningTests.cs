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

/// <summary>Bypasses <c>TrackAsync</c>, whose gate refuses the fixture outright: calls the same two
/// primitives it calls, skipping only <c>VerifyRoundTrip</c>, which is exactly the shape of a plugin
/// tracked before the gate existed or by hand.</summary>
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

        // Track directly (bypassing TrackService.TrackAsync's own round-trip gate — see class doc comment).
        var deepParsed = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(FixtureFileName), pluginPath), GameRelease.Fallout4,
            LocalizedStrings.ForRead(_modFolder));
        var pristineFiles = TrackService.SerializeToPristineFiles(deepParsed, FixtureFileName, CancellationToken.None)
            .GetAwaiter().GetResult();
        SourceRepository.Track(_modFolder, SourcePreset.Edits, pristineFiles, new TrackProvenance(null, null, new Dictionary<string, string>()));
    }

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

    [Fact]
    public void Compile_OfTheRealSpaDiaAMRFixtureTrackedBeforeTheFix_LeavesNoOrphanedTempDirectory()
    {
        var compileService = new PluginCompileService(
            _mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

        var result = compileService.Compile(_plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Empty(Directory.GetDirectories(_modFolder, ".medit_tmp_*"));
        Assert.Single(Directory.GetFiles(_modFolder, "*.bak.esp"));
    }

    public void Dispose()
    {
        _mirror.Dispose();
        try { Directory.Delete(_modFolder, recursive: true); } catch (IOException) { }
        try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
    }
}
