using System.Text.Json;
using MEditService.Core.Session;

namespace MEditService.Core.Edits;

// Origin (#271 / ADR-0036): same rationale as PendingChangeUpsert.Origin — binds this staged member
// to the compound identity. Required (#275): every construction must say which origin. Kept in its
// original trailing position rather than reordered before Source/ParentCell/PlacementGroup (all
// also `string`/`string?`) — moving it earlier would let an existing positional caller's literal
// silently land in the wrong slot instead of failing to compile. Source/ParentCell/PlacementGroup
// lose their own defaults as a consequence (C# requires every required parameter to precede every
// optional one) — a small, safe widening: existing callers relying on those defaults now name them
// explicitly with the same value the default used to supply, not a behavior change.
public record GroupMember(
    string FormKey,
    string Plugin,
    string RecordType,
    string ChangeType,
    string FieldPath,
    JsonElement OldValue,
    JsonElement NewValue,
    string Source,
    // Placement intent for placed records (refr/achr). Null for every non-placed member.
    string? ParentCell,
    string? PlacementGroup,
    string Origin);
