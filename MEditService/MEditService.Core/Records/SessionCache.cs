using System.Security.Cryptography;
using System.Text;
using MEditService.Core.Session;
using DuckDB.NET.Data;

namespace MEditService.Core.Records;

public static class SessionCache
{
    public static string ComputeLoadOrderHash(IEnumerable<PluginMetadata> plugins)
    {
        var sb = new StringBuilder();
        foreach (var p in plugins)
        {
            sb.Append(p.Name);
            sb.Append(':');
            if (File.Exists(p.Path))
                sb.Append(File.GetLastWriteTimeUtc(p.Path).Ticks);
            sb.Append(';');
        }
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public static bool NeedsReindex(DuckDBConnection connection, string currentHash)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT load_order_hash FROM index_state LIMIT 1";
        var stored = cmd.ExecuteScalar() as string;
        return stored != currentHash;
    }

    public static void StoreState(DuckDBConnection connection, string hash)
    {
        Execute(connection, "DELETE FROM index_state");
        Execute(connection,
            $"INSERT INTO index_state (indexed_at, load_order_hash) VALUES (CURRENT_TIMESTAMP, '{EscapeSql(hash)}')");
    }

    private static void Execute(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static string EscapeSql(string value) => value.Replace("'", "''");
}
