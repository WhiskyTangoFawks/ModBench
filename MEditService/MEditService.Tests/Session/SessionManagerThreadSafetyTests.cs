using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Session;

public class SessionManagerThreadSafetyTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);
    private static readonly IFieldMetadataMapper _mapper = new FieldMetadataMapper();

    public SessionManagerThreadSafetyTests(TestPluginFixture fixture) => _fixture = fixture;

    private SessionManager MakeLoadedManager()
    {
        var m = new SessionManager(_reflector, _ddl, _mapper);
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

    [Fact]
    public async Task CreatePlugin_SessionHasNewPlugin()
    {
        using var manager = MakeLoadedManager();

        var task = Task.Run(() => manager.CreatePlugin("Added.esp"));
        var completed = await Task.WhenAny(task, Task.Delay(5000));
        Assert.Same(task, completed);
        await task;

        var names = manager.Session!.Plugins.Select(p => p.Name).ToList();
        Assert.Contains("Added.esp", names);
        Assert.Contains(TestPluginFixture.PluginName, names);
    }

    // --- CreatePlugin guard clauses ---

    [Fact]
    public void CreatePlugin_NoSession_Throws()
    {
        using var manager = new SessionManager(_reflector, _ddl, _mapper);
        Assert.Throws<InvalidOperationException>(() => manager.CreatePlugin("X.esp"));
    }

    [Fact]
    public void CreatePlugin_InvalidExtension_Throws()
    {
        using var manager = MakeLoadedManager();
        Assert.Throws<ArgumentException>(() => manager.CreatePlugin("Plugin.txt"));
    }

    [Fact]
    public void CreatePlugin_FileAlreadyExists_Throws()
    {
        using var manager = MakeLoadedManager();
        // TestPluginFixture.PluginName already exists in the data folder
        Assert.Throws<IOException>(() => manager.CreatePlugin(TestPluginFixture.PluginName));
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
    public void Dispose_ClearsSession()
    {
        var manager = MakeLoadedManager();
        manager.Dispose();

        Assert.Null(manager.Session);
        Assert.Null(manager.Repository);
    }
}
