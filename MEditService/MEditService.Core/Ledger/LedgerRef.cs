namespace MEditService.Core.Ledger;

/// <summary>
/// Reserved values for the <c>records.ref</c> column — which git ref a document's bytes came from.
/// ADR-0041 spells <c>ref</c> into the published documents-table shape as an identity column,
/// replacing ADR-0025's committed/staged view split with a ref dimension.
///
/// #413 ingested everything from a plugin binary, which is the committed baseline by definition, so
/// the column carried exactly one value; #415 gives it the second, which is where the dimension
/// starts doing work. The column was carried from the start rather than added later because it is
/// part of a published SQL contract — user filter SQL and <c>medit.query</c> scripts read this table
/// directly — and changing a table's identity after callers exist costs more than carrying one
/// constant column does.
///
/// <para><b>What the column means, now that it has two values.</b> <c>records</c> holds exactly one
/// row per record copy and that row is always the <see cref="Records.RecordRef.Effective"/> state;
/// this column says which state those bytes <i>are</i>, never which of several rows to pick. So a
/// filter or script reading <c>records</c> unqualified sees what the editor sees and what Save
/// &amp; Compile would emit — and <c>WHERE "ref" = 'working-tree'</c> is how it asks for just the
/// dirt. The committed bytes of a diverged record live in the <c>records_committed</c> difference
/// table (<c>TableDdlBuilder</c>), which is not a second copy of the read model.</para>
///
/// The names follow the vocabulary already in the codebase for exactly this distinction —
/// ADR-0025's <c>&lt;type&gt;_committed</c> tables and spike-359's "non-committed ref".
/// </summary>
internal static class LedgerRef
{
    /// <summary>The baseline: a document whose bytes are what the last commit holds — either
    /// serialized from the plugin binary at ingest, or refreshed from the ledger file when a read
    /// found it agreeing with <c>HEAD</c> again.</summary>
    internal const string Committed = "committed";

    /// <summary>The document's bytes differ from the committed ones: an uncommitted edit is live in
    /// the mod's working tree (CONTEXT.md's "Working-tree change"). Set only where the difference is
    /// established by a byte compare — never inferred from a <c>content_hash</c> mismatch alone,
    /// which is one-directional (see <see cref="GitBlobHash"/>).</summary>
    internal const string WorkingTree = "working-tree";
}
