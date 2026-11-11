using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.RecordIndex.Store;

/// <summary>A column of a streamed query: text, which is encoded as a JSON string here, or the JSON text DuckDB made.</summary>
internal sealed record StreamedColumn(string Name, bool IsText);

/// <summary>Each row of one query as the JSON text of an object of its columns, read from DuckDB as it is taken. It
/// owns its read, which disposing it ends.</summary>
internal sealed class StreamedRows(ReadContext read, DuckDBCommand command, IReadOnlyList<StreamedColumn> columns) : IDisposable
{
    private readonly string[] _names = [.. columns.Select(column => Encoded(column.Name))];
    private DuckDBDataReader? _reader;

    /// <summary>The next row's JSON object, or null after the last row.</summary>
    public string? Next()
    {
        _reader ??= StoreFaults.Translating(command.ExecuteReader);
        if (!StoreFaults.Translating(_reader.Read)) return null;
        var row = new StringBuilder("{");
        for (var i = 0; i < columns.Count; i++)
        {
            if (i > 0) row.Append(',');
            row.Append(_names[i]).Append(':');
            if (_reader.IsDBNull(i)) row.Append("null");
            else row.Append(columns[i].IsText ? Encoded(_reader.GetString(i)) : _reader.GetString(i));
        }
        return row.Append('}').ToString();
    }

    private static string Encoded(string text) => $"\"{JsonEncodedText.Encode(text, JavaScriptEncoder.UnsafeRelaxedJsonEscaping)}\"";

    public void Dispose()
    {
        _reader?.Dispose();
        command.Dispose();
        read.Dispose();
    }
}
