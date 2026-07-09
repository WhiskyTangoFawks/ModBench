using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Session;

public class SessionManagerThreadSafetyTests(TestPluginFixture fixture) : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture = fixture;

    private static SessionManager MakeManager()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
    }

    private SessionManager MakeLoadedManager()
    {
        var m = MakeManager();
        m.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        return m;
    }

    // --- CreatePlugin (deadlock regression) ---

    [Fact]
    public async Task CreatePlugin_CompletesWithoutDeadlock()
    {
        using var manager = MakeLoadedManager();

        // If CreatePlugin() calls Load() from inside lock(_lock) with a non-reentrant lock,
        // the same thread deadlocks. Use a timeout to catch that case.
        var task = Task.Run(() => manager.CreatePlugin("NewPlugin.esp"));
        var completed = await Task.WhenAny(task, Task.Delay(5000));

        Assert.Same(task, completed); // timed out = deadlock
        await task; // surface any exception
    }

    [Fact]
    public async Task CreatePlugin_ReturnsMetadataForNewPlugin()
    {
        using var manager = MakeLoadedManager();

        var task = Task.Run(() => manager.CreatePlugin("Created.esp"));
        var completed = await Task.WhenAny(task, Task.Delay(5000));
        Assert.Same(task, completed);

        var result = await task;
        Assert.Equal("Created.esp", result.Name);
        Assert.False(result.IsImmutable);
    }

    // Session-membership and guard-clause behavior (NoSession/InvalidExtension/FileAlreadyExists)
    // are covered by SessionManagerTests; this class keeps only the concurrency-specific cases.

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
    public void Dispose_ClearsSession()
    {
        var manager = MakeLoadedManager();
        manager.Dispose();

        Assert.Null(manager.Session);
        Assert.Null(manager.Repository);
    }
}
