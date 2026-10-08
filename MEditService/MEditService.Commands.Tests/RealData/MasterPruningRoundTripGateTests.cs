using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.RealData;

public sealed class MasterPruningRoundTripGateTests
{
    private const string SpaDiaAmrFixtureFileName = "SpaDia_AMR.esp";

    private static string PathTo(string fixtureFileName) =>
        Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName);

    [Theory]
    [InlineData(UnusedMasterPlugins.RecordlessFileName)]
    [InlineData(UnusedMasterPlugins.OverridesFileName)]
    public async Task TrackAsync_OfAGeneratedPluginWithUnusedMasters_AcceptsDespiteThePrunedMaster(string fileName)
    {
        var generated = UnusedMasterPlugins.Named(fileName);
        using var scratch = new PrunedMasterScratch(generated, "UnusedMasterMod");
        Assert.Equal(generated.Masters, scratch.DeclaredMasters());

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfTheRealSpaDiaAMRFixture_RefusesNamingTheQuestAndThePrunedMaster()
    {
        using var scratch = new PrunedMasterScratch(new GeneratedPlugin(SpaDiaAmrFixtureFileName, File.ReadAllBytes(PathTo(SpaDiaAmrFixtureFileName))), "SpaDiaAMRMod");

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", result.Message);
        Assert.Contains("DLCNukaWorld.esm", result.Message);
        Assert.Contains("Mutagen #688", result.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    private sealed class PrunedMasterScratch : IDisposable
    {
        private readonly string _fixtureFileName;
        private readonly string _origin;
        private readonly ScratchDirectory _gameDirectory = new("medit-masterprune-game-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-masterprune-");

        public PrunedMasterScratch(GeneratedPlugin plugin, string origin)
        {
            _fixtureFileName = plugin.FileName;
            _origin = origin;
            plugin.WriteInto(ModFolder);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(Path.Combine(ModFolder, _fixtureFileName), _origin, _gameDirectory);
        }

        public IReadOnlyList<string> DeclaredMasters()
        {
            var path = Path.Combine(ModFolder, _fixtureFileName);
            using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(_fixtureFileName), path), Fallout4Release.Fallout4);
            return [.. overlay.ModHeader.MasterReferences.Select(m => m.Master.FileName.String)];
        }

        public async Task<PluginTrack> TrackAsync() =>
            (await TrackEveryPluginOf.ModAsync(_loadOrder, _origin)).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
