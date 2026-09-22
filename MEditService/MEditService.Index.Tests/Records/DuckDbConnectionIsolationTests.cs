using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Records;

/// <summary>Characterization of DuckDB.NET, not of ours: a duplicated connection sees the same database and
/// does not see another connection's uncommitted transaction.</summary>
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

    // Why the Index gates its own writes: two projections overlapping on the shared connection
    // fail here, and the failure names a transaction rather than anything either caller asked for.
    [Fact]
    public void SecondTransactionOnTheSameConnection_Throws_RatherThanNesting()
    {
        using var connection = OpenMemory();
        Execute(connection, "CREATE TABLE t (id INTEGER)");

        using var first = connection.BeginTransaction();
        Execute(connection, "INSERT INTO t VALUES (1)");

        var second = Record.Exception(() => connection.BeginTransaction());

        var invalid = Assert.IsType<InvalidOperationException>(second);
        Assert.Equal("Already in a transaction.", invalid.Message);
    }

    // Silent: the joining caller is never warned, and loses its write on the other's rollback.
    [Fact]
    public void AnUnwrappedWrite_JoinsAnotherCallersOpenTransaction_AndIsLostWhenItRollsBack()
    {
        using var connection = OpenMemory();
        Execute(connection, "CREATE TABLE t (id INTEGER)");

        var tx = connection.BeginTransaction();
        Execute(connection, "INSERT INTO t VALUES (1)"); // the transaction owner's own write

        // A second caller on the same connection, opening no transaction and told of no failure.
        Execute(connection, "INSERT INTO t VALUES (2)");

        tx.Rollback(); // the *first* caller's edit failed — the second caller's did not
        tx.Dispose();

        Assert.Equal(0, CountRows(connection));
    }
}
