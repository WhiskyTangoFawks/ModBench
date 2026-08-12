using System.Text.Json;
using MEditService.Core.Session;

namespace MEditService.Core.Edits;

// Origin (#271 / ADR-0036): same rationale as PendingChangeUpsert.Origin — binds this staged member
// to the compound identity; defaulted so pre-existing direct constructions keep compiling.
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
    string? PlacementGroup = null,
    string Origin = PluginOrigin.DataDirectory);
