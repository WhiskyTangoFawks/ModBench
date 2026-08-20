using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

/// <summary>
/// A record's ledger record-type folder name — the same resolution
/// <c>DuckDbRecordIndex.ResolveRecordType</c> uses (schema table name by type match, else the CLR
/// type name lowercased). Shared by every caller that deep-parses a plugin binary straight to
/// pristine ledger text: <see cref="TrackService"/> (Track) and #417's Absorb Upstream Update, which
/// is exactly the same operation — a fresh baseline serialized from a binary — for a different
/// reason.
/// </summary>
internal static class LedgerRecordType
{
    internal static string Resolve(IMajorRecordGetter record, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsInstanceOfType(record)) return tableName;
        }

        return record.GetType().Name.ToLowerInvariant();
    }
}
