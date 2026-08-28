using MEditService.Core.Queries;

namespace MEditService.Core.Records;

/// <summary>
/// One plugin's copy of one record, reconstituted from its stored document (ADR-0041 / #413 D1).
/// <see cref="Body"/> is exactly the bytes the record's source file would hold — the same document
/// <c>records.body</c> stores — null for the header (D8: a ModHeader is not an
/// <see cref="Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter"/>, so it has no document at
/// all). <see cref="Fields"/> is the same typed, schema-driven extraction <c>RecordDetail</c>
/// carried before this reshape (<see cref="Schema.ColumnSpec.Extract"/> delegates, byte-identical
/// by construction) — Records/ still owns this extraction; only its container type changed.
///
/// <para><see cref="IsPartialForm"/> (#491): <see cref="Schema.PartialFormFlag.IsSet"/> read off the
/// live deserialized record at the same point <see cref="Fields"/> is extracted — always false for
/// the header (a <c>ModHeader</c> can never carry the flag).</para>
/// </summary>
public record RecordDocument(
    string FormKey,
    PluginKey Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    string RecordType,
    string? Body,
    IReadOnlyList<FieldValue> Fields,
    bool IsPartialForm = false);

/// <summary>
/// One plugin's position in a record's override stack. <see cref="Effective"/> and
/// <see cref="Head"/> are the same <see cref="RecordDocument"/> instance and
/// <see cref="HasWorkingTreeChange"/> is always false in #421 — Head/Effective divergence is #415's
/// addition; this ticket only carries the shape.
/// </summary>
public record OverrideStackEntry(
    PluginKey Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    RecordDocument Effective,
    RecordDocument Head,
    bool HasWorkingTreeChange);

/// <summary>Every plugin's copy of one record, in load-order — the "override stack" the pinned
/// contract names <see cref="IRecordReads.GetOverrideStack"/> for; the type itself is
/// <c>RecordOverrides</c> rather than <c>OverrideStack</c> only because CA1711 rejects a public
/// type name ending in "Stack" that isn't itself a collection type. Replaces
/// <c>GetAllOverrides(tableName, formKey)</c> — the record's type no longer needs to be named by
/// the caller (it's a property of the record found, not a dispatch key).</summary>
public record RecordOverrides(string FormKey, string RecordType, IReadOnlyList<OverrideStackEntry> Entries);

/// <summary>
/// A closed set of listing options — filters and paging only, no projection/ordering axis (a
/// listing is always "form_key, plugin, load_order_idx, is_winner, editor_id, origin", ordered by
/// EditorID, exactly as before). Replaces <c>GetRecords(tableName, ...)</c> (one type) and
/// <c>SearchRecords(tableNames, ...)</c> (several) as the same shape — <see cref="RecordTypes"/>
/// null/empty means every type, matching <c>SearchRecords</c>' own "all schema tables" call
/// sites.
/// </summary>
/// <param name="Plugin">A filter, not an identity field — see <see cref="PluginKey"/>'s own
/// null-<c>Origin</c> semantics for the filter case this is.</param>
public sealed record RecordQuery(
    IReadOnlyList<string>? RecordTypes = null,
    PluginKey? Plugin = null,
    string? Search = null,
    int Limit = 50,
    int Offset = 0);

/// <summary>One record type's row count for one plugin — replaces the per-type
/// <c>CountRecordsForPlugin</c> loop <c>RecordQueryService.GetPluginRecordTypes</c> used to run,
/// with one grouped query.</summary>
public record RecordTypeCount(string Type, int Count);
