using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;

namespace MEditService.Core.Records;

/// <summary>Indexes the ModHeader as an ordinary <c>records</c> row at FormKey
/// <c>000000:&lt;plugin&gt;</c> — the null form, which no major record can occupy — with the root
/// <c>RecordData.json</c> as its body.</summary>
internal static class HeaderIndexer
{
    /// <summary>Appends the header row and returns its <c>form_lookup</c> row rather than writing it,
    /// so the one-lookup-row-per-record-row invariant is a property of a single flush.</summary>
    public static (string FormKey, string RecordType, string? EditorId) Index(
        PluginDocument header, string plugin, string origin, DuckDBAppender documentAppender)
    {
        var body = Encoding.UTF8.GetBytes(header.Text);

        var row = documentAppender.CreateRow();
        row.AppendValue(header.FormKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(PluginHeader.RecordType);
        row.AppendNullValue();    // editor_id: headers have no EditorID concept
        row.AppendValue(SourceRef.Committed);
        row.AppendValue(header.Text);
        row.AppendValue(SourceRepository.ContentHash(body));
        row.AppendNullValue();    // parse_diagnosis: the header is written from what already parsed
        row.EndRow();

        return (header.FormKey, PluginHeader.RecordType, null);
    }
}
