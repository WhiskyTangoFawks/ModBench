using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex;

/// <summary>Indexes the ModHeader as an ordinary <c>records</c> row at FormKey
/// <c>000000:&lt;plugin&gt;</c> — the null form, which no major record can occupy — with the root
/// <c>RecordData.json</c> as its body.</summary>
internal static class HeaderIndexer
{
    public static void Index(
        PluginDocument header, string plugin, string origin, DuckDBAppender documentAppender)
    {
        var row = documentAppender.CreateRow();
        row.AppendValue(header.FormKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(PluginHeader.RecordType);
        row.AppendNullValue();    // editor_id: headers have no EditorID concept
        row.AppendValue(WorkingTreeState.None.Stored());
        row.AppendValue(header.Text);
        row.AppendValue(SourceRepository.ContentStamp(header.Text));
        row.AppendNullValue();    // parse_diagnosis: the header is written from what already parsed
        row.AppendValue(new List<string>());
        row.AppendValue(RecordMasters.PluginNamedBy(header.FormKey));
        row.EndRow();
    }
}
