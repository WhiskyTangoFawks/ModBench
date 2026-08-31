namespace MEditService.Core.Source;

/// <summary>
/// Reserved values for the <c>records.ref</c> column — which git ref a document's bytes came from.
/// ADR-0041 spells <c>ref</c> into the published documents-table shape as an identity column,
/// the ref dimension.
///
/// The column is part of a published SQL contract — user filter SQL and <c>medit.query</c> scripts
/// read this table directly.
///
/// <para><b>What the column means.</b> <c>records</c> holds exactly one
/// row per record copy and that row is always the <see cref="Records.RecordRef.Effective"/> state;
/// this column says which state those bytes <i>are</i>, never which of several rows to pick. So a
/// filter or script reading <c>records</c> unqualified sees what the editor sees and what Save
/// &amp; Compile would emit — and <c>WHERE "ref" = 'working-tree'</c> is how it asks for just the
/// dirt. The committed bytes of a diverged record live in the <c>records_committed</c> difference
/// table (<c>TableDdlBuilder</c>), which is not a second copy of the read model.</para>
///
/// The names follow CONTEXT.md's committed / working-tree vocabulary.
/// </summary>
internal static class SourceRef
{
    /// <summary>The baseline: a document whose bytes are what the last commit holds — either
    /// serialized from the plugin binary at ingest, or refreshed from the source file when a read
    /// found it agreeing with <c>HEAD</c> again.</summary>
    internal const string Committed = "committed";

    /// <summary>The document's bytes differ from the committed ones: an uncommitted edit is live in
    /// the mod's working tree (CONTEXT.md's "Working-tree change"). Set only where the difference is
    /// established by a byte compare — never inferred from a <c>content_hash</c> mismatch alone,
    /// which is one-directional (see <see cref="GitBlobHash"/>).</summary>
    internal const string WorkingTree = "working-tree";
}
