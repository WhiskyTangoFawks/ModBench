using System.Text.Json;
using MEditService.Core.Records;

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
    string? ParentCell = null,
    string? PlacementGroup = null,   // "persistent" | "temporary"
                                     // ADR-0031: resolution signal for every FormKey-typed value inside NewValue, populated by
                                     // PendingChangeResolver — keyed by the FormRefPathBuilder-style sub-path within NewValue ("" for
                                     // a scalar formKey field itself, "[0]"/".member" for a leaf inside an atomic staged struct/array
                                     // blob, ADR-0019). Never aggregated: each leaf's signal is independent of its siblings'. Null
                                     // when FieldPath isn't a FormKey-carrying field or no resolver was supplied.
    IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null
);
