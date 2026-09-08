using MEditService.Core.Records;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Records;

public sealed class IndexStoreRebuildTests
{
    private static long MarkerTables(DuckDB.NET.Data.DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'marker'";
        return (long)cmd.ExecuteScalar()!;
    }

    [Fact]
    public async Task ARebuildWithAReadInFlight_LeavesNothingOfTheOldFileBehind()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"idx-rebuild-{Guid.NewGuid():N}");
        var store = new IndexStore(NullLogger.Instance, Path.Combine(dir, "index.duckdb"));
        try
        {
            store.Initialize("test");
            DuckDbSql.ExecuteFor(store.Connection, "CREATE TABLE marker(i INTEGER)");

            var inFlight = store.OpenReadConnection();
            Assert.Equal(1, MarkerTables(inFlight));
            var released = Task.Run(async () => { await Task.Delay(300); inFlight.Dispose(); });

            store.RebuildFile();
            await released;

            using var afterwards = store.OpenReadConnection();
            Assert.True(MarkerTables(afterwards) == 0, "the rebuilt index still holds the old file's table — a read in flight kept the deleted file's database alive");
            Assert.Equal(0, MarkerTables(store.Connection));
        }
        finally
        {
            store.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }
}
