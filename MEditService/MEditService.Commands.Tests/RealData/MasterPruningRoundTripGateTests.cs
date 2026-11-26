using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.RealData;

public sealed class MasterPruningRoundTripGateTests
{
    [Fact]
    public async Task VersionInGit_OfAPluginWithAMasterNoRecordUses_AcceptsDespiteThePrunedMaster()
    {
        using var modFolder = new ScratchDirectory("medit-masterprune-");
        using var dataFolder = new ScratchDirectory("medit-masterprune-data-");
        var plugin = UnusedMasterPlugins.Recordless;
        plugin.WriteInto(modFolder);
        var loadOrder = EmptyMasterStubs.LoadOrderOver(Path.Combine(modFolder, plugin.FileName), "UnusedMasterMod", dataFolder);

        var result = (await VersionInGitEveryPluginOf.ModAsync(loadOrder, "UnusedMasterMod")).Only();

        Assert.True(result.Applied, result.Message);
    }
}
