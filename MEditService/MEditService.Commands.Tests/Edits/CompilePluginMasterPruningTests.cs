using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginMasterPruningTests : IDisposable
{
    private const string FixtureFileName = "SpaDia_AMR.esp";
    private const string Origin = "SpaDiaAMRCompileMod";

    private readonly ScratchDirectory _gameDirectory = new("medit-520-compile-game-");
    private readonly ScratchDirectory _modFolder = new("medit-520-compile-mod-");
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginAddress _plugin = new(FixtureFileName, Origin);

    public CompilePluginMasterPruningTests()
    {
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "TestData", FixtureFileName);
        var pluginPath = Path.Combine(_modFolder, FixtureFileName);
        File.Copy(fixturePath, pluginPath);

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

        _loadOrder = SnapshotPlugins.Snapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, inputs);

        var (treeFiles, _) = TestAdapters.Mutagen().ReadSourceAsync(
            new ModPath(ModKey.FromFileName(FixtureFileName), pluginPath), FixtureFileName, GameRelease.Fallout4,
            PluginStrings.In(_modFolder)).GetAwaiter().GetResult();
        var pristineFiles = SourceRepository.PristineFilesOf(FixtureFileName, treeFiles);
        SourceRepository.Track(
            _modFolder, [(pristineFiles, new DecompiledPlugin(FixtureFileName, null))]);
    }

    [Fact]
    public async Task Compile_OfTheRealSpaDiaAMRFixtureTrackedWithoutTheRoundTripGate_RefusesNamingTheQuestAndThePrunedMaster_LeavingNoTempDirectory()
    {
        var compileService = CompileServices.Over(_loadOrder);

        var result = await compileService.CompileOneAsync(_plugin);

        Assert.False(result.Succeeded);
        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", result.RefusalReason);
        Assert.Contains("DLCNukaWorld.esm", result.RefusalReason);
        Assert.Contains("Mutagen #688", result.RefusalReason);
        Assert.Empty(Directory.GetDirectories(_modFolder, ".medit_tmp_*"));
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _gameDirectory.Dispose();
    }
}
