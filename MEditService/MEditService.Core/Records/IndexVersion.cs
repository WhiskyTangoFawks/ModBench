using System.Security.Cryptography;
using System.Text;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// What shape the rows in a persistent index file were written under (ADR-0001). Stored on
/// every <c>mirror.files</c> row; a mismatch at open invalidates the <b>whole</b> file, which
/// is then rebuilt from scratch, because a stale document shape must never be served and there is
/// no partial answer to a schema change.
///
/// <para>Three parts, each covering a different way the stored shape can go stale:</para>
/// <list type="bullet">
/// <item><see cref="FormatVersion"/> — <b>hand-bumped</b>, and the one obligation this class puts on
/// a future change: anything that alters the fixed tables' DDL (<see cref="TableDdlBuilder"/>) or the
/// codec's own conventions must bump it. <c>CREATE TABLE IF NOT EXISTS</c> silently leaves an
/// existing file's old column list in place, so a column added without a bump would meet rows that
/// do not have it.</item>
/// <item>The Mutagen assembly version — the record documents are its serializer's output, so an
/// upgrade can change every body in the file without a line of our own code changing.</item>
/// <item>A digest of the reflected schema for this release — the per-type views and the extracted
/// columns are generated from it (ADR-0005), so a reflector change invalidates them with nobody
/// having to remember. This is the "reflector version" ADR-0001 names.</item>
/// </list>
/// </summary>
internal static class IndexVersion
{
    /// <summary>Bump on any change to <see cref="TableDdlBuilder"/>'s fixed tables or to the record
    /// codec's conventions — see this class's own summary for why nothing else can catch those.</summary>
    private const int FormatVersion = 3;

    internal static string For(SchemaReflector reflector, GameRelease release)
    {
        var mutagen = typeof(IModGetter).Assembly.GetName().Version?.ToString() ?? "unknown";
        return $"{FormatVersion}|{release}|{mutagen}|{SchemaDigest(reflector, release)}";
    }

    // Table name, column name and DuckDB type of every reflected column, in a deterministic order —
    // the whole of what the generated views and the extracted columns are built from.
    private static string SchemaDigest(SchemaReflector reflector, GameRelease release)
    {
        var sb = new StringBuilder();
        foreach (var (table, schema) in reflector.GetSchemas(release).OrderBy(s => s.Key, StringComparer.Ordinal))
        {
            sb.Append(table).Append('{');
            foreach (var column in schema.RecordColumns.OrderBy(c => c.Name, StringComparer.Ordinal))
                sb.Append(column.Name).Append(':').Append(column.DuckDbType).Append(',');
            sb.Append('}');
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())))[..16];
    }
}
