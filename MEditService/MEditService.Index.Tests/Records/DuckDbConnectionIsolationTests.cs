using System.Globalization;
using DuckDB.NET.Data;

namespace MEditService.Index.Tests.Records;

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

        var read = Task.Run(() => CountRows(reader));

        var readOrTheTimeoutThatMeansItBlockedBehindTheWritersTransaction =
            await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.Same(read, readOrTheTimeoutThatMeansItBlockedBehindTheWritersTransaction);
        Assert.Equal(1, await read);
    }

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

    [Fact]
    public void AnUnwrappedWrite_JoinsAnotherCallersOpenTransaction_AndIsLostWhenItRollsBack()
    {
        using var connection = OpenMemory();
        Execute(connection, "CREATE TABLE t (id INTEGER)");

        var ownerTransaction = connection.BeginTransaction();
        Execute(connection, "INSERT INTO t VALUES (1)");

        Execute(connection, "INSERT INTO t VALUES (2)");

        ownerTransaction.Rollback();
        ownerTransaction.Dispose();

        Assert.Equal(0, CountRows(connection));
    }
}
