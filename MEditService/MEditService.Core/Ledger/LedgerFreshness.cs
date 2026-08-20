using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Ledger;

/// <summary>
/// Read-time freshness validation (#413 D3, deferred to #415): before the record editor or compare
/// grid answers for a FormKey, the ledger text those answers claim to reflect is re-checked, and
/// anything that moved out of band is folded in.
///
/// <para><b>Why read time and not a watcher.</b> Modbench owns the <c>.git</c> folder, so git itself
/// is the change source — <c>git restore</c> from the Source Control panel, a checkout, a rebase, a
/// terminal commit, a hand edit, an agent's script. None of those notify anybody, and a filesystem
/// watcher would still miss the ones that move <c>HEAD</c> without touching a file. Validating where
/// the answer is produced is the only place that catches all of them, and it costs nothing on the
/// overwhelmingly common path (see below).</para>
///
/// <para><b>Both refs are re-derived, never just the working-tree side.</b> After an external commit
/// "committed" itself has moved: refreshing only Effective would leave Head serving bytes no ref
/// holds any more, and the record reading as permanently dirty against a baseline that no longer
/// exists. So the pass asks two independent questions — does the file still match what the index
/// serves at Effective, and does <c>HEAD</c> still hold the bytes the index calls committed.</para>
///
/// <para><b>The cost is bounded by dirt, not by load order.</b> The file compare is a small read per
/// record of the FormKey being looked at. git is consulted only for records the index already
/// believes are dirty — for a clean record the stored committed bytes, the file and <c>HEAD</c> agree
/// by construction, so there is nothing a git call could discover. In a session where nothing has
/// been edited, this pass runs no git processes at all.</para>
///
/// <para>A <c>content_hash</c> mismatch is never treated as proof of a user edit — it routes to a
/// byte compare, which decides (<see cref="GitBlobHash"/>'s one-directional contract).</para>
/// </summary>
public sealed class LedgerFreshness(ISessionManager sessions, ILogger<LedgerFreshness> logger)
{
    /// <summary>
    /// Re-validates every tracked plugin's copy of <paramref name="formKey"/>. Safe to call for an
    /// unknown FormKey, an untracked plugin or with no session loaded — each is simply nothing to do,
    /// never a failure: this runs on the read path, and a read must not start throwing because a mod
    /// folder was deleted while the editor was open.
    /// </summary>
    public void Validate(string formKey)
    {
        var index = sessions.Index;
        var session = sessions.Session;
        if (index == null || session == null) return;

        var stack = index.GetOverrideStack(formKey);
        if (stack == null) return;

        foreach (var entry in stack.Entries)
        {
            try
            {
                ValidateOne(index, session, entry, stack.RecordType, formKey);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                // A read must degrade to "serve what we have", never fail, when the ledger cannot be
                // consulted — the folder vanished mid-read, the file is locked by another tool, git
                // is mid-rebase. Logged rather than swallowed (modbench/CLAUDE.md: no silent catch).
                logger.LogWarning(ex,
                    "Could not validate ledger freshness for {FormKey} in {Plugin}; serving the indexed state",
                    formKey, entry.Plugin.Name);
            }
        }
    }

    private void ValidateOne(
        IRecordIndex index, IGameSession session, OverrideStackEntry entry, string recordType, string formKey)
    {
        if (ModFolders.TrackedOf(session, entry.Plugin) is not { } modFolder) return;

        var relativePath = LedgerRecordPath.For(entry.Plugin.Name, recordType, formKey);
        var fullPath = Path.Combine(modFolder, relativePath);

        var fileText = File.Exists(fullPath) ? File.ReadAllText(fullPath) : null;
        if (!string.Equals(fileText, entry.Effective.Body, StringComparison.Ordinal))
        {
            // The file is the source for a tracked plugin, so whatever it says now is Effective —
            // including a null, which is the record's file having been deleted. ApplyWorkingTreeChanges
            // decides for itself whether that is a change or a convergence back to committed.
            index.ApplyWorkingTreeChanges(entry.Plugin, [(formKey, fileText)]);
            // #422: a read-time self-heal is still a mutation — the row it just folded in can newly
            // (or no longer) match an active filter, same as an explicit edit would.
            sessions.ReapplyFilter();
            logger.LogDebug(
                "Ledger text for {FormKey} in {Plugin} changed outside Modbench; refreshed at read time",
                formKey, entry.Plugin.Name);
        }

        RebaselineIfHeadMoved(index, entry, modFolder, relativePath, formKey);
    }

    /// <summary>
    /// The second question: has <c>HEAD</c> moved past what the index calls committed. Asked only for
    /// a record the index already believes is dirty — for a clean one the committed bytes are the
    /// file's bytes, which the compare above has just confirmed, so there is nothing to find and no
    /// git process is started.
    /// </summary>
    private void RebaselineIfHeadMoved(
        IRecordIndex index, OverrideStackEntry entry, string modFolder, string relativePath, string formKey)
    {
        var head = index.At(RecordRef.Head).GetDocument(formKey, entry.Plugin);
        if (head?.Body is not { } committedBody) return;

        var hashes = LedgerRepository.CommittedLedgerHashes(modFolder, [relativePath]);
        if (hashes == null || !hashes.TryGetValue(relativePath.Replace('\\', '/'), out var headHash)) return;

        // Hash equality is conclusive (identical bytes), which is exactly the direction relied on
        // here: equal means HEAD still holds what the index calls committed, so there is nothing to
        // do. Inequality only sends us to fetch the real text and compare bytes — never on its own an
        // assertion that anything changed.
        if (headHash == GitBlobHash.Of(Encoding.UTF8.GetBytes(committedBody))) return;

        if (LedgerRepository.ReadCommittedLedgerText(modFolder, relativePath) is not { } headText) return;
        if (string.Equals(headText, committedBody, StringComparison.Ordinal)) return;

        index.SetCommittedBaseline(entry.Plugin, [(formKey, headText)]);
        logger.LogDebug(
            "HEAD moved under {FormKey} in {Plugin}; committed baseline re-established at read time",
            formKey, entry.Plugin.Name);
    }
}
