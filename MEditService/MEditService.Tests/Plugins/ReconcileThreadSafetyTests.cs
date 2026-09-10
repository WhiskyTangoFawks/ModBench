using MEditService.Core.Edits;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

[Collection(TestPluginFixtureCollection.Name)]
public class ReconcileThreadSafetyTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static IndexProjector MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new IndexProjector(MutagenPluginAdapter.Instance, factory);
    }

    private IndexProjector MakeLoadedManager()
    {
        var m = MakeManager();
        m.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }

    // --- Dispose idempotency ---

    [Fact]
    public void Dispose_CalledTwice_DoesNotThrow()
    {
        var manager = MakeLoadedManager();
        manager.Dispose();

        // Should not throw a LockRecursionException or ObjectDisposedException
        var ex = Record.Exception(() => manager.Dispose());
        Assert.Null(ex);
    }

    [Fact]
    public void Dispose_ClearsLoadOrder()
    {
        var manager = MakeLoadedManager();
        manager.Dispose();

        Assert.Null(manager.LoadOrder);
        Assert.Null(manager.Reads);
    }
}
