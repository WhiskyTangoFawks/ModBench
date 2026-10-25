using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.RealData;

public sealed class SubrecordInventoryRoundTripGateTests
{
    [Fact]
    public async Task DecompileAndCommit_OfAShortRdatRegionPlugin_RefusesNamingTheRegionAndItsDroppedSignatures()
    {
        using var scratch = new ShortRdatScratch();

        var result = await scratch.DecompileAndCommitAsync();

        Assert.False(result.Applied);
        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("REGN", result.Message);
        Assert.Contains("01000800", result.Message);
        Assert.Contains("RDMP", result.Message);
        Assert.Contains("ANAM", result.Message);
        Assert.Contains("RDMO", result.Message);
        Assert.Contains("RDSA", result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(scratch.ModFolder));
    }

    private sealed class ShortRdatScratch : IDisposable
    {
        private readonly ScratchDirectory _dataFolder = new("medit-shortrdat-data-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-shortrdat-");

        public ShortRdatScratch()
        {
            var plugin = ShortRdatRegionPlugin.Plugin;
            plugin.WriteInto(ModFolder);
            var pluginPath = Path.Combine(ModFolder, plugin.FileName);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(pluginPath, "ShortRdatMod", _dataFolder);
        }

        public async Task<PluginDecompiledAndCommitted> DecompileAndCommitAsync() =>
            (await DecompileAndCommitEveryPluginOf.ModAsync(_loadOrder, "ShortRdatMod")).Only();

        public void Dispose()
        {
            ModFolder.Dispose();
            _dataFolder.Dispose();
        }
    }
}
