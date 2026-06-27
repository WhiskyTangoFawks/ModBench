using System.Text.Json;

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
    Guid? GroupId,
    // Placement intent for placed records (refr/achr). Null for every non-placed change.
    // Parentage is structural (a cell's Persistent/Temporary GRUP), not a record field, so it
    // rides on the change rather than the reflected record table. See ADR-0023.
    string? ParentCell = null,
    string? PlacementGroup = null   // "persistent" | "temporary"
);
