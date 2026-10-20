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
    public async Task DecompileAndCommit_OfAGeneratedPluginWithUnusedMasters_AcceptsDespiteThePrunedMaster(string fileName)
    {
        var generated = UnusedMasterPlugins.Named(fileName);
        using var scratch = new PrunedMasterScratch(generated, "UnusedMasterMod");
        Assert.Equal(generated.Masters, scratch.DeclaredMasters());

        await scratch.DecompileAndCommitAsync();

        Assert.True(TestAdapters.Source().IsSourceMod(scratch.ModFolder));
    }

    private sealed class PrunedMasterScratch : IDisposable
    {
        private readonly string _fixtureFileName;
        private readonly string _origin;
        private readonly ScratchDirectory _dataFolder = new("medit-masterprune-game-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-masterprune-");

        public PrunedMasterScratch(GeneratedPlugin plugin, string origin)
        {
            _fixtureFileName = plugin.FileName;
            _origin = origin;
            plugin.WriteInto(ModFolder);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(Path.Combine(ModFolder, _fixtureFileName), _origin, _dataFolder);
        }

        public IReadOnlyList<string> DeclaredMasters()
        {
            var path = Path.Combine(ModFolder, _fixtureFileName);
            using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(_fixtureFileName), path), Fallout4Release.Fallout4);
            return [.. overlay.ModHeader.MasterReferences.Select(m => m.Master.FileName.String)];
        }

        public async Task<PluginDecompiledAndCommitted> DecompileAndCommitAsync() =>
            (await DecompileAndCommitEveryPluginOf.ModAsync(_loadOrder, _origin)).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _dataFolder.Dispose();
        }
    }
}
