using System.Text.Json;
using MEditService.Core.Records;
using MEditService.Core.Session;

namespace MEditService.Core.Edits;

public record PendingChange(
    Guid Id,
    string FormKey,
    string Plugin,
    string FieldPath,
    string RecordType,       // DuckDB table name, e.g. "npc_"
    JsonElement OldValue,    // on-disk original; JsonValueKind.Null when unknown
    JsonElement NewValue,
    string Source,           // "user" | "agent"
    string? Description,
    DateTime ChangedAt,
    string ChangeType,       // "field_edit" | "create" | "delete" | "renumber"
                             // Placement intent for placed records (refr/achr). Null for every non-placed change.
                             // Parentage is structural (a cell's Persistent/Temporary GRUP), not a record field, so it
                             // rides on the change rather than the reflected record table. See ADR-0023.
    string? ParentCell,
    string? PlacementGroup,   // "persistent" | "temporary"
                              // ADR-0031: resolution signal for every FormKey-typed value inside NewValue, populated by
                              // PendingChangeResolver — keyed by the FormRefPathBuilder-style sub-path within NewValue ("" for
                              // a scalar formKey field itself, "[0]"/".member" for a leaf inside an atomic staged struct/array
                              // blob, ADR-0019). Never aggregated: each leaf's signal is independent of its siblings'. Null
                              // when FieldPath isn't a FormKey-carrying field or no resolver was supplied.
    IReadOnlyDictionary<string, FormKeyResolution>? Resolutions,
    // ADR-0031: resolution signal for the change's own FormKey (record identity), distinct from
    // Resolutions above (which is scoped to leaves inside NewValue). Populated unconditionally by
    // PendingChangeResolver — the Pending Changes tree's `{RecordType} / {EditorID}` leaf label
    // reads this, not Resolutions, since the record's own FormKey is never a leaf of its own
    // NewValue. No expected-type list applies to identity (empty validTypes), same as VMAD.
    FormKeyResolution? RecordResolution,
    // Issue #110: xEdit-parity display name for RecordType (e.g. "Non-Player Character" for
    // "npc_"), populated unconditionally by PendingChangeResolver from the schema's DisplayName.
    // Additive — RecordType (the signature) is unchanged and still the field everything else
    // keys off. Falls back to RecordType itself when the type isn't a known schema.
    string? RecordTypeDisplayName,
    // Origin (#272 / ADR-0036): paired with Plugin, never encoded into it — mirrors RecordDetail.
    // #271 already stores a real origin on every pending_changes row (via PendingChangeUpsert.Origin/
    // GroupMember.Origin) and keys the table's PK on it; this is the response DTO catching up to
    // read it back out. Required (#275): every construction must say which origin. Kept in its
    // original trailing position, and every optional field before it loses its own default too
    // (C# requires required-before-optional) rather than risk an existing positional caller's
    // literal silently landing in the wrong slot if Origin moved earlier instead.
    string Origin
);
