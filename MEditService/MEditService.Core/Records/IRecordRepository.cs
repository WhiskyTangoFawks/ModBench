using DuckDB.NET.Data;

namespace MEditService.Core.Records;

public interface IRecordRepository : IRecordIndexer, IRecordReader
{
    DuckDBConnection Connection { get; }

    /// <summary>
    /// Materializes a _filter table from <paramref name="sql"/> (null = clear).
    /// Throws <see cref="ArgumentException"/> if the SQL does not return a form_key column.
    /// </summary>
    void SetFilter(string? sql);
}
