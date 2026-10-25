using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class MasterStylesIndexTests
{
    [Fact]
    public void APluginWhoseMasterIsLight_IsReadAgainstTheLoadOrdersCopyOfItsMaster()
    {
        using var scratch = new ScratchDirectory("medit-master-styles-");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        index.Receive(holder, LightMasterAndChild.LoadOrderIn(scratch.Path));

        Assert.Empty(index.Status.Failures);
        Assert.Equal(
            [("weap", 1)],
            index.Queries.GetPluginRecordTypes(new PluginAddress(LightMasterAndChild.Child.FileName, PluginOrigin.DataDirectory))
                .Value().Select(t => (t.Type, t.Count)));
    }
}
