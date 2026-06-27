using System.Text.Json;

namespace MEditService.Core.Edits;

public record GroupMember(
    string FormKey,
    string Plugin,
    string RecordType,
    string ChangeType,
    string FieldPath,
    JsonElement OldValue,
    JsonElement NewValue,
    string Source = "system",
    // Placement intent for placed records (refr/achr). Null for every non-placed member.
    string? ParentCell = null,
    string? PlacementGroup = null);
