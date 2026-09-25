using System.Security.Cryptography;
using System.Text;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>The shape a persistent file's rows were written under (ADR-0009); a mismatch at open
/// rebuilds the whole file. Four parts: format version, game release, Mutagen assembly version,
/// and a digest of the reflected schema.</summary>
internal static class IndexVersion
{
    // Bump on any change to TableDdlBuilder's fixed tables or the codec's conventions: CREATE TABLE
    // IF NOT EXISTS leaves an existing file's old column list in place, so nothing else catches those.
    private const int FormatVersion = 7;

    public static string For(SchemaReflector reflector, GameRelease release)
    {
        return $"{FormatVersion}|{release}|{SchemaReflector.MutagenVersion}|{SchemaDigest(reflector, release)}";
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
