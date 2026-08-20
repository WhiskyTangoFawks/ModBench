namespace MEditService.Core.Ledger;

/// <summary>
/// Reserved values for the <c>records.ref</c> column — which git ref a document's bytes came from.
/// ADR-0041 spells <c>ref</c> into the published documents-table shape as an identity column,
/// replacing ADR-0025's committed/staged view split with a ref dimension.
///
/// <b>One value exists today, deliberately.</b> Everything #413 ingests is read from a plugin
/// binary, which is the committed baseline by definition; a second value arrives with the edit path
/// (#415), which is where the dimension starts doing work. The column is carried now rather than
/// added later because it is part of a published SQL contract — user filter SQL and
/// <c>medit.query</c> scripts read this table directly — and changing a table's identity after
/// callers exist costs more than carrying one constant column does. No ref-aware machinery goes
/// with it: nothing reads it, no read method takes a ref, and nothing anticipates divergence.
///
/// The name follows the vocabulary already in the codebase for exactly this distinction —
/// ADR-0025's <c>&lt;type&gt;_committed</c> tables and spike-359's "non-committed ref".
/// </summary>
internal static class LedgerRef
{
    /// <summary>The baseline: a document serialized from what the plugin file itself holds.</summary>
    internal const string Committed = "committed";
}
