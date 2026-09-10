using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>Indexes the ModHeader as an ordinary <c>records</c> row at FormKey
/// <c>000000:&lt;plugin&gt;</c> — the null form, which no major record can occupy — with the root
/// <c>RecordData.json</c> as its body.</summary>
internal static class HeaderIndexer
{
    /// <summary>Appends the header row and returns its <c>form_lookup</c> row rather than writing it,
    /// so ADR-0031's one-lookup-row-per-record-row invariant is a property of a single flush.</summary>
    public static (string FormKey, string RecordType, string? EditorId) Index(
        IModGetter pluginMod, string plugin, string origin, DuckDBAppender documentAppender)
    {
        var formKey = PluginHeader.FormKeyFor(pluginMod.ModKey);
        var body = HeaderDocument.Write(pluginMod);

        var row = documentAppender.CreateRow();
        row.AppendValue(formKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(PluginHeader.RecordType);
        row.AppendNullValue();    // editor_id: headers have no EditorID concept
        row.AppendValue(SourceRef.Committed);
        row.AppendValue(Encoding.UTF8.GetString(body));
        // Hashed from the document's own bytes, never a string round trip, so the hash is defined by
        // what the source file holds.
        row.AppendValue(GitBlobHash.Of(body));
        row.AppendNullValue();    // parse_diagnosis: the header is written from what already parsed
        row.EndRow();

        return (formKey, PluginHeader.RecordType, null);
    }
}
