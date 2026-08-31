using System.Globalization;
using DuckDB.NET.Data;

namespace MEditService.Tests.Records;

/// <summary>
/// Characterization of DuckDB.NET's own behaviour, not of ours. Progressive loading indexes
/// on a second connection over the same in-memory database while readers keep answering on the
/// first, and the whole design rests on two properties this file pins down: a duplicated connection
/// sees the *same* database, and it does not see another connection's uncommitted transaction.
///
/// Kept as executable documentation rather than deleted after the spike — if a DuckDB.NET upgrade
/// ever changes either property, the failure should name the assumption directly instead of
/// surfacing as an intermittent "a plugin briefly had no records" bug in the Plugins tree.
/// </summary>
public class DuckDbConnectionIsolationTests
{
    private static DuckDBConnection OpenMemory()
    {
        var connection = new DuckDBConnection("DataSource=:memory:");
        connection.Open();
        return connection;
    }

    private static void Execute(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static long CountRows(DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM t";
        return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    [Fact]
    public void DuplicatedConnection_SeesTheSameDatabase()
    {
        using var writer = OpenMemory();
        Execute(writer, "CREATE TABLE t (id INTEGER)");
        Execute(writer, "INSERT INTO t VALUES (1)");

        using var reader = writer.Duplicate();
        reader.Open();

        Assert.Equal(1, CountRows(reader));
    }

    [Fact]
    public void DuplicatedConnection_DoesNotSeeAnUncommittedTransaction()
    {
        using var writer = OpenMemory();
        Execute(writer, "CREATE TABLE t (id INTEGER)");
        using var reader = writer.Duplicate();
        reader.Open();

        using var tx = writer.BeginTransaction();
        Execute(writer, "INSERT INTO t VALUES (1)");

        // The whole of "no read ever observes a partially-indexed plugin": one plugin is one
        // transaction on the indexing connection, so a reader sees it wholly or not at all.
        Assert.Equal(0, CountRows(reader));

        tx.Commit();

        Assert.Equal(1, CountRows(reader));
    }

    [Fact]
    public async Task ReadsOnTheDuplicate_AreServedWhileTheWriterHoldsAnOpenTransaction()
    {
        using var writer = OpenMemory();
        Execute(writer, "CREATE TABLE t (id INTEGER)");
        Execute(writer, "INSERT INTO t VALUES (1)");
        using var reader = writer.Duplicate();
        reader.Open();

        using var tx = writer.BeginTransaction();
        Execute(writer, "INSERT INTO t VALUES (2)");

        // Not merely "reads the old value" — reads *complete*. A reader that blocked until the
        // indexer committed would meet the isolation AC and fail the "reads are served throughout
        // the load" one, and the two are indistinguishable without a timeout.
        var read = Task.Run(() => CountRows(reader));

        var completed = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.Same(read, completed); // timed out = the read blocked behind the writer's transaction
        Assert.Equal(1, await read);
    }
}
