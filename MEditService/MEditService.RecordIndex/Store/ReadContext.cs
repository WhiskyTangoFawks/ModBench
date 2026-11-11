using System.Data.Common;
using DuckDB.NET.Data;

namespace MEditService.RecordIndex.Store;

/// <summary>One snapshot of the record index: every query a read asks sees one state, whatever a write commits
/// meanwhile. A context from <see cref="Store.OpenRead"/> is the reader's to dispose.</summary>
internal sealed class ReadContext : IDisposable
{
    private readonly DuckDBConnection _connection;
    private readonly bool _owned;

    /// <summary>Takes <paramref name="connection"/>, which holds a transaction open, to dispose.</summary>
    internal ReadContext(DuckDBConnection connection) : this(connection, owned: true)
    {
    }

    private ReadContext(DuckDBConnection connection, bool owned)
    {
        _connection = connection;
        _owned = owned;
    }

    /// <summary>The same snapshot, which disposing the borrowed context leaves open.</summary>
    public ReadContext Borrowed() => new(_connection, owned: false);

    public List<T> Rows<T>(string sql, Func<DbDataReader, T> map, params object?[] args) =>
        DuckDbSql.Rows(_connection, sql, map, args);

    public int Execute(string sql, params object?[] args) => DuckDbSql.Execute(_connection, sql, args);

    public string? ScalarString(string sql, params object?[] args) => DuckDbSql.ScalarString(_connection, sql, args);

    public T Scalar<T>(string sql, params object?[] args) where T : struct => DuckDbSql.Scalar<T>(_connection, sql, args);

    /// <summary>The names of the columns <paramref name="sql"/> returns, read without running it over a row.</summary>
    public List<string> ColumnNames(string sql)
    {
        return StoreFaults.Translating(() =>
        {
            using var command = _connection.CreateCommand();
            // The newline keeps a trailing line comment in the SQL from swallowing the wrapper.
            command.CommandText = $"SELECT * FROM ({sql}\n) __probe LIMIT 0";
            using var reader = command.ExecuteReader();
            return Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToList();
        });
    }

    public void Dispose()
    {
        if (_owned) _connection.Dispose();
    }
}
