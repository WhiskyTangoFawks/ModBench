namespace MEditService.Core.Queries;

// DTO for the container-child read — a Quest's dialog topics/branches/scenes, a Dialog
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
    int LoadOrderIndex, bool IsWinner, WorkingTreeState WorkingTreeState, string RecordType,
    // #560: carried straight through from the RecordSummary this row was hydrated from — a
    // returned "dial" child (a Quest's own Dialog Topic) is itself a container the Plugins tree
    // recurses into, and needs this same presence fact to decide its own expand chevron.
    bool HasContainerChildren = false);
