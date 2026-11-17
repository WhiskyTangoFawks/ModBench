using System.Data.Common;
using DuckDB.NET.Data;
using DuckDB.NET.Native;

namespace MEditService.RecordIndex.Store;

/// <summary>One snapshot of the record index: every query a read asks sees one state, whatever a write commits
/// meanwhile. The reader disposes it. DuckDB's interrupt ends only the running query, so each later one checks the token.</summary>
internal sealed class ReadContext : IDisposable
{
    private readonly DuckDBConnection _connection;
    private readonly CancellationToken _cancel;
    private readonly CancellationTokenRegistration _interrupting;
    private readonly bool _owned;

    /// <summary>Takes <paramref name="connection"/>, which holds a transaction open, to dispose.</summary>
    internal ReadContext(DuckDBConnection connection, CancellationToken cancel) : this(connection, owned: true, cancel)
    {
    }

    private ReadContext(DuckDBConnection connection, bool owned, CancellationToken cancel)
    {
        _connection = connection;
        _cancel = cancel;
        _owned = owned;
        if (owned) _interrupting = cancel.Register(() => NativeMethods.Startup.DuckDBInterrupt(connection.NativeConnection));
    }

    /// <summary>The same snapshot, which disposing the borrowed context leaves open.</summary>
    public ReadContext Borrowed() => new(_connection, owned: false, _cancel);

    /// <summary>Runs <paramref name="read"/> unless cancellation was requested. A fault of a read interrupted by it is the
    /// cancellation.</summary>
    internal T Observed<T>(Func<T> read)
    {
        _cancel.ThrowIfCancellationRequested();
        try
        {
            return read();
        }
        catch (Exception ex) when (ex is IndexFaultException or OperationCanceledException && _cancel.IsCancellationRequested)
        {
            throw new OperationCanceledException(_cancel);
        }
    }

    public List<T> Rows<T>(string sql, Func<DbDataReader, T> map, params object?[] args) =>
        Observed(() => DuckDbSql.Rows(_connection, sql, map, args));

    // DESCRIBE's name for plain text, which JSON, a text type of its own, is not.
    private const string TextType = "VARCHAR";

    /// <summary>Each row of <paramref name="sql"/> as the JSON text of an object of its columns, read as it is taken.
    /// The rows take this context, which disposing them ends.</summary>
    public StreamedRows Streamed(string sql)
    {
        // The newline keeps a trailing line comment in the SQL from swallowing the wrapper.
        var columns = Rows($"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM ({sql}\n) __row)",
            reader => new StreamedColumn(reader.GetString(0), reader.GetString(1) == TextType));
        // DuckDB's to_json of an FSST-compressed column holds every string it returns until the scan ends, so a
        // SELECT of body would hold every body. Text is encoded as it is read instead.
        var values = string.Join(", ", columns.Select((column, i) => column.IsText ? $"c{i}" : $"to_json(c{i})"));
        var aliases = string.Join(", ", columns.Select((_, i) => $"c{i}"));
        var command = _connection.CreateCommand();
        command.CommandText = $"SELECT {values} FROM ({sql}\n) __row({aliases})";
        command.UseStreamingMode = true;
        return new StreamedRows(this, command, columns);
    }

    public int Execute(string sql, params object?[] args) => Observed(() => DuckDbSql.Execute(_connection, sql, args));

    public string? ScalarString(string sql, params object?[] args) => Observed(() => DuckDbSql.ScalarString(_connection, sql, args));

    public T Scalar<T>(string sql, params object?[] args) where T : struct => Observed(() => DuckDbSql.Scalar<T>(_connection, sql, args));

    /// <summary>The names of the columns <paramref name="sql"/> returns, read without running it over a row.</summary>
    public List<string> ColumnNames(string sql)
    {
        return Observed(() => StoreFaults.Translating(() =>
        {
            using var command = _connection.CreateCommand();
            // The newline keeps a trailing line comment in the SQL from swallowing the wrapper.
            command.CommandText = $"SELECT * FROM ({sql}\n) __probe LIMIT 0";
            using var reader = command.ExecuteReader();
            return Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToList();
        }));
    }

    public void Dispose()
    {
        if (!_owned) return;
        _interrupting.Dispose();
        _connection.Dispose();
    }
}
