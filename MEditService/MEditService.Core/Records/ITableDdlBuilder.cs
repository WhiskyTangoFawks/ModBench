using DuckDB.NET.Data;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public interface ITableDdlBuilder
{
    void CreateTables(DuckDBConnection connection, GameRelease release);
}
