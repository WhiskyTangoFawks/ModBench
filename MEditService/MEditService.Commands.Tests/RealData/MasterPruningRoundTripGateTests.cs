using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.RealData;

public sealed class MasterPruningRoundTripGateTests
{
    [Theory]
    [InlineData(UnusedMasterPlugins.RecordlessFileName)]
    [InlineData(UnusedMasterPlugins.OverridesFileName)]
    public async Task TrackAsync_OfAGeneratedPluginWithUnusedMasters_AcceptsDespiteThePrunedMaster(string fileName)
    {
        var generated = UnusedMasterPlugins.Named(fileName);
        using var scratch = new PrunedMasterScratch(generated, "UnusedMasterMod");
        Assert.Equal(generated.Masters, scratch.DeclaredMasters());

        await scratch.TrackAsync();

        Assert.True(TestAdapters.Source().IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfAGeneratedStructListLink_RefusesNamingTheQuestAndThePrunedMaster()
    {
        using var scratch = new PrunedMasterScratch(StructListLinkPlugin.Plugin, "StructListLinkMod");
        Assert.Equal([StructListLinkPlugin.Master], scratch.DeclaredMasters());

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(StructListLinkPlugin.QuestEditorId, result.Message);
        Assert.Contains(StructListLinkPlugin.Master, result.Message);
        Assert.Contains("Mutagen #688", result.Message);
        Assert.False(TestAdapters.Source().IsTracked(scratch.ModFolder));
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
