namespace MEditService.Core.Records;

/// <summary>Reserved values for the <c>records.ref</c> column, a published SQL contract (user filter
/// SQL, <c>medit.query</c> scripts). It says which state a row's bytes are, never which of several
/// rows to pick.</summary>
internal static class SourceRef
{
    /// <summary>The document's bytes are what the last commit holds.</summary>
    internal const string Committed = "committed";

    /// <summary>The bytes differ from the committed ones. Set only where a byte compare established the
    /// difference — never inferred from a <c>content_hash</c> mismatch alone, which is one-directional.</summary>
    internal const string WorkingTree = "working-tree";
}
