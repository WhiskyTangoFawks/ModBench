using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using DuckDB.NET.Data;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

public class SessionCacheTests : IDisposable
{
    private readonly string _dataFolder;

    public SessionCacheTests()
    {
        _dataFolder = Path.Combine(Path.GetTempPath(), $"medit-sc-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_dataFolder);
    }

    public void Dispose() => Directory.Delete(_dataFolder, recursive: true);

    private PluginMetadata MakePlugin(string name)
    {
        var path = Path.Combine(_dataFolder, name);
        File.WriteAllText(path, "test");
        return new PluginMetadata(name, path, 0, false, false, [], 0, false);
    }

    [Fact]
    public void ComputeLoadOrderHash_SameInput_ReturnsSameHash()
    {
        var plugins = new[] { MakePlugin("Test.esp") };
        var hash1 = SessionCache.ComputeLoadOrderHash(plugins);
        var hash2 = SessionCache.ComputeLoadOrderHash(plugins);
        Assert.Equal(hash1, hash2);
    }

    [Fact]
    public void ComputeLoadOrderHash_ChangedMtime_ReturnsDifferentHash()
    {
        var plugins = new[] { MakePlugin("Test.esp") };
        var hash1 = SessionCache.ComputeLoadOrderHash(plugins);

        File.SetLastWriteTimeUtc(plugins[0].Path, DateTime.UtcNow.AddSeconds(2));

        var hash2 = SessionCache.ComputeLoadOrderHash(plugins);
        Assert.NotEqual(hash1, hash2);
    }

    [Fact]
    public void ComputeLoadOrderHash_DifferentPluginList_ReturnsDifferentHash()
    {
        var plugins1 = new[] { MakePlugin("A.esp") };
        var plugins2 = new[] { MakePlugin("A.esp"), MakePlugin("B.esp") };
        var hash1 = SessionCache.ComputeLoadOrderHash(plugins1);
        var hash2 = SessionCache.ComputeLoadOrderHash(plugins2);
        Assert.NotEqual(hash1, hash2);
    }

    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(new SchemaReflector());

    [Fact]
    public void NeedsReindex_NoStoredState_ReturnsTrue()
    {
        using var conn = OpenMemory();
        _ddl.CreateTables(conn, GameRelease.Fallout4);
        Assert.True(SessionCache.NeedsReindex(conn, "abc123"));
    }

    [Fact]
    public void NeedsReindex_StoredHashMatches_ReturnsFalse()
    {
        using var conn = OpenMemory();
        _ddl.CreateTables(conn, GameRelease.Fallout4);
        SessionCache.StoreState(conn, "abc123");
        Assert.False(SessionCache.NeedsReindex(conn, "abc123"));
    }

    [Fact]
    public void NeedsReindex_StoredHashDiffers_ReturnsTrue()
    {
        using var conn = OpenMemory();
        _ddl.CreateTables(conn, GameRelease.Fallout4);
        SessionCache.StoreState(conn, "old_hash");
        Assert.True(SessionCache.NeedsReindex(conn, "new_hash"));
    }

    [Fact]
    public void StoreState_UpdatesExistingRow()
    {
        using var conn = OpenMemory();
        _ddl.CreateTables(conn, GameRelease.Fallout4);
        SessionCache.StoreState(conn, "hash1");
        SessionCache.StoreState(conn, "hash2");
        Assert.False(SessionCache.NeedsReindex(conn, "hash2"));
    }

    private static DuckDBConnection OpenMemory()
    {
        var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        return conn;
    }
}
