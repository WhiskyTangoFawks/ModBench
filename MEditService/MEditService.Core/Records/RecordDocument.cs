using MEditService.Core.Queries;

namespace MEditService.Core.Records;

/// <summary>
/// One plugin's copy of one record, reconstituted from its stored document (ADR-0041).
/// <see cref="Body"/> is exactly the bytes the record's source file would hold — the same document
/// <c>records.body</c> stores — null for the header (a ModHeader is not an
/// <see cref="Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter"/>, so it has no document at
/// all). <see cref="Fields"/> is the typed, schema-driven extraction
/// (<see cref="Schema.ColumnSpec.Extract"/> delegates), owned by Records/.
///
/// <para><see cref="IsPartialForm"/>: <see cref="Schema.PartialFormFlag.IsSet"/> read off the
/// live deserialized record at the same point <see cref="Fields"/> is extracted — always false for
/// the header (a <c>ModHeader</c> can never carry the flag).</para>
///
/// <para><see cref="IsPartialFormable"/>: <see cref="Schema.PartialFormFlag.IsPartialFormable"/>
/// on this record's own concrete type — independent of <see cref="IsPartialForm"/>'s current bit
/// state, this is "could this record ever carry the flag at all." The webview needs this to decide
/// whether to render its own Partial Form toggle at all (<c>PluginHeader.tsx</c>) without
/// hand-duplicating <see cref="Source.ContainerChildFields"/>'s own container-type table client-side
/// — the exact shape of drift that table's own completeness sweep exists to guard against
/// (<c>ContainerChildFieldsCompletenessTests</c>).</para>
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
    bool IsPartialForm = false,
    bool IsPartialFormable = false);

/// <summary>
/// One plugin's position in a record's override stack. For a record with no working-tree change,
/// <see cref="Effective"/> and <see cref="Head"/> are the same <see cref="RecordDocument"/> instance
/// (an identity, not merely equal values) and <see cref="HasWorkingTreeChange"/> is false; for a
/// dirty one, <see cref="Head"/> is resolved separately from the committed baseline and the two
/// diverge.
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
/// type name ending in "Stack" that isn't itself a collection type. The record's type is not named
/// by the caller — it's a property of the record found, not a dispatch key.</summary>
public record RecordOverrides(string FormKey, string RecordType, IReadOnlyList<OverrideStackEntry> Entries);

/// <summary>
/// A closed set of listing options — filters and paging only, no projection/ordering axis (a
/// listing is always "form_key, plugin, load_order_idx, is_winner, editor_id, origin", ordered by
/// EditorID). <see cref="RecordTypes"/> null/empty means every type.
/// </summary>
/// <param name="Plugin">A filter, not an identity field — see <see cref="PluginKey"/>'s own
/// null-<c>Origin</c> semantics for the filter case this is.</param>
public sealed record RecordQuery(
    IReadOnlyList<string>? RecordTypes = null,
    PluginKey? Plugin = null,
    string? Search = null,
    int Limit = 50,
    int Offset = 0);

/// <summary>One record type's row count for one plugin, from one grouped query.</summary>
public record RecordTypeCount(string Type, int Count);
