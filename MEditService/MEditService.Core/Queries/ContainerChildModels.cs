namespace MEditService.Core.Queries;

// DTO for the container-child read (#424) — a Quest's dialog topics/branches/scenes, a Dialog
// Topic's responses. Deliberately container-type-agnostic: only Quest/DialogTopic are wired to it
// today (Cell/Worldspace keep their own dedicated worldspace-tree surface unchanged), but nothing
// about the shape below is Quest/DialogTopic-specific.

/// <summary>
/// One child record of a container, in xEdit's own presentation order (see
/// <see cref="ContainerChildQueryService"/>'s class doc comment). A flattened
/// <see cref="RecordSummary"/> plus <see cref="RecordType"/> — the raw record signature
/// (<c>"dial"</c>, <c>"dlbr"</c>, <c>"scen"</c>, <c>"info"</c>) the frontend needs to know a
/// returned Dialog Topic is itself a further-expandable container, the same reason
/// <see cref="PlacedSummary"/> already carries a <c>RecordType</c>.
/// </summary>
public record ContainerChildSummary(
    string FormKey, string? EditorId, string Plugin, string Origin,
    int LoadOrderIndex, bool IsWinner, WorkingTreeState WorkingTreeState, string RecordType);
