using DuckDB.NET.Data;

namespace MEditService.Core.Records;

/// <summary>
/// Shared null-aware DuckDB appender helpers, used by the VMAD and placement indexing paths.
/// </summary>
internal static class DuckDbAppend
{
    public static void Nullable(IDuckDBAppenderRow row, bool? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    public static void Nullable(IDuckDBAppenderRow row, int? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    public static void Nullable(IDuckDBAppenderRow row, float? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    public static void Nullable(IDuckDBAppenderRow row, short? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    public static void Nullable(IDuckDBAppenderRow row, string? val)
    {
        if (val != null) row.AppendValue(val); else row.AppendNullValue();
    }
}
