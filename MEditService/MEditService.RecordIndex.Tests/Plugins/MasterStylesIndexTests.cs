using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class MasterStylesIndexTests
{
    [Fact]
    public void APluginWhoseMasterIsLight_IsReadAgainstTheLoadOrdersCopyOfItsMaster()
    {
        using var scratch = new ScratchDirectory("medit-master-styles-");
        var (masterPath, childPath) = LightMasterAndChild.Write(scratch.Path);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        index.Reconcile(holder, scratch.Path,
        [
            new LoadOrderEntry(LightMasterAndChild.Master.FileName, masterPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry(LightMasterAndChild.Child.FileName, childPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
        ], GameRelease.Starfield);

        Assert.Empty(index.Status.Failures);
        Assert.Equal(
            [("weap", 1)],
            index.Queries.GetPluginRecordTypes(new PluginAddress(LightMasterAndChild.Child.FileName, PluginOrigin.DataDirectory))
                .Value().Select(t => (t.Type, t.Count)));
    }
}
