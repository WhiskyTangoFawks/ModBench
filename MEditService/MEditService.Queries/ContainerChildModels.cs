using MEditService.Index;

namespace MEditService.Queries;

// Container-type-agnostic by design: only Quest/DialogTopic are wired to it; Cell/Worldspace keep
// their own worldspace-tree surface.

/// <summary>One child record of a container, in xEdit's presentation order. RecordType is the raw
/// signature ("dial", "dlbr", "scen", "info") the frontend needs to know a returned Dialog Topic
/// is itself expandable.</summary>
public record ContainerChildSummary(
    string FormKey, string? EditorId, string Plugin, string Origin,
    int LoadOrderIndex, bool IsWinner, WorkingTreeState WorkingTreeState, string RecordType,
    // A returned "dial" child is itself a container the Plugins tree recurses into, so it needs
    // the same presence fact for its own expand chevron.
    bool HasContainerChildren = false,
    // The same pair every record row carries: this child's own diagnosis, and the fact widened to
    // its own children so the tree renders the failure prefix without walking them.
    string? ParseDiagnosis = null,
    bool HasParseFailure = false);
