using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

[Collection(TestPluginFixtureCollection.Name)]
public class ReconcileThreadSafetyTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static IndexProjector MakeManager(LoadOrderHolder holder) => Indexes.Open(holder);

    private IndexProjector MakeLoadedManager(LoadOrderHolder holder)
    {
        var m = MakeManager(holder);
        m.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }

    // --- Dispose idempotency ---

    [Fact]
    public void Dispose_CalledTwice_DoesNotThrow()
    {
        var holder = new LoadOrderHolder();
        var manager = MakeLoadedManager(holder);
        manager.Dispose();

        // Should not throw a LockRecursionException or ObjectDisposedException
        var ex = Record.Exception(() => manager.Dispose());
        Assert.Null(ex);
    }

    [Fact]
    public void Dispose_ClearsLoadOrder()
    {
        var holder = new LoadOrderHolder();
        var manager = MakeLoadedManager(holder);
        manager.Dispose();

        Assert.Throws<NoLoadOrderException>(() => manager.RequireReads());
    }
}
