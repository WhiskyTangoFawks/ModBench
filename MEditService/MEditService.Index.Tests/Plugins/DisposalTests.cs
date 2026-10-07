using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

[Collection(TestPluginFixtureCollection.Name)]
public class DisposalTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static OpenedIndex OpenIndex(LoadOrderHolder holder) => Indexes.Open(holder);

    private OpenedIndex ReconciledIndex(LoadOrderHolder holder)
    {
        var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return index;
    }

    [Fact]
    public void Dispose_CalledTwice_DoesNotThrow()
    {
        var holder = new LoadOrderHolder();
        var index = ReconciledIndex(holder);
        index.Dispose();

        var ex = Record.Exception(() => index.Dispose());
        Assert.Null(ex);
    }

    [Fact]
    public void Dispose_ClearsLoadOrder()
    {
        var holder = new LoadOrderHolder();
        var index = ReconciledIndex(holder);
        index.Dispose();

        Assert.Throws<NoLoadOrderException>(() => index.RequireReads());
    }
}
