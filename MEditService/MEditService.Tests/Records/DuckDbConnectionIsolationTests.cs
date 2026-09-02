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

    /// <summary>
    /// #673: the gap the two tests above leave open. They pin cross-<i>connection</i> isolation,
    /// which is sound. This one pins what happens when two callers open a transaction on the
    /// <b>same</b> connection — which is what the record index actually offers, since every
    /// singleton service reaches it through one shared <c>DuckDbRecordIndex.Connection</c> and every
    /// <c>BeginTransaction()</c> in that class is on it.
    ///
    /// <para>Characterization, not a wish: whatever DuckDB.NET does here is what an unserialized
    /// pair of overlapping writes gets, and it is recorded so the reason the process-wide write gate
    /// (<c>MEditService.Core.Records.IndexWriteGate</c>) exists is not a matter of belief. The answer
    /// is that it throws <see cref="InvalidOperationException"/> — precisely the exception type
    /// <c>WriteEndpointMapping.Execute</c> maps to a 503 "the load order went away", so before the
    /// gate an overlapping write surfaced to the user as a nonsense
    /// <c>503 "Already in a transaction."</c>, and <c>SourceFreshness</c> — which catches the same
    /// type to keep reads from ever throwing — swallowed the collision entirely.</para>
    /// </summary>
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

    /// <summary>
    /// #673, the half that corrupts rather than merely throwing: a caller that issues statements on
    /// the shared connection <i>without</i> opening a transaction of its own — every unwrapped
    /// <c>Connection.CreateCommand()</c> write in <c>DuckDbRecordIndex</c> — silently joins whatever
    /// transaction another caller already has open, and dies with it. The second write below never
    /// fails, is never warned about, and is gone the instant the unrelated first caller rolls back.
    /// This is the shape #572's rollback work cannot be built on top of: a restore would attribute
    /// another request's writes to the failed action.
    /// </summary>
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
