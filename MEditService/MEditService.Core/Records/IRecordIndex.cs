using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// The Index (glossary sense): ingest plus every read, over one game/load order's worth of indexed
/// plugins. One implementation over DuckDB; no ports, no production double.
///
/// No <c>Connection</c> property and no SQL crosses this seam except <see cref="SetFilter"/>
/// (invariant 8).
/// </summary>
public interface IRecordIndex : IDisposable
{
    /// <summary>Repositions every <see cref="IRecordReads"/> read at <paramref name="recordRef"/>.
    /// (Named <c>recordRef</c> rather than a literal <c>ref</c>/<c>@ref</c>: CA1716 rejects a
    /// virtual/interface parameter named after the reserved keyword even escaped.)</summary>
    IRecordReads At(RecordRef recordRef);

    void Initialize(GameRelease release);

    /// <summary>Indexes one physical plugin file's records, header, references, form_lookup and
    /// placement, replacing whatever <paramref name="key"/> previously held (one
    /// document per major record plus the extracted index tables derived from it).
    ///
    /// <para>ADR-0001: <paramref name="filePath"/> is the physical file this content came
    /// from, and giving it is what makes the resulting rows <i>validatable</i> — the index stamps
    /// that file's content hash alongside them, re-checks it every time the index is opened, and
    /// drops the rows when the bytes have moved on. Omitting it is not a shortcut but a different,
    /// honest claim: these rows are backed by no file on disk (an in-memory mod), so nothing can
    /// vouch for them across a restart and the next load re-indexes. A tracked plugin still passes
    /// its binary's path even though its rows came from the source tree — the stamp is what lets a
    /// vanished or replaced binary take its stale rows with it; that its rows are re-ingested from
    /// source on every reconcile regardless is <c>LoadOrderMirror</c>'s rule, not this one's.</para>
    /// <para>ADR-0044: <paramref name="registration"/> is the load order's three facts about this
    /// copy, written to its <c>registrations</c> row exactly as <see cref="Register"/> would.</para></summary>
    void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null);

    /// <summary>ADR-0001: the content hash of the file <paramref name="key"/>'s rows were
    /// built from, or <see langword="null"/> when the index holds no validated rows for it — never
    /// indexed, indexed from no file at all, or dropped by the open-time validation because the file
    /// vanished or its bytes changed. Non-null therefore reads as "the index already holds this
    /// plugin, and it still matches the disk", which is what lets a reconcile
    /// <see cref="Register"/> it instead of indexing it and the runtime watcher tell a real
    /// change from a touch.
    ///
    /// <para>Independent of registration, deliberately: it is a fact about a file, and it has to
    /// keep answering for a plugin the load order does not currently hold — a profile switch that
    /// comes back is exactly the case ADR-0001 exists to make cheap.</para></summary>
    string? IndexedContentHash(PluginKey key);

    /// <summary>Removes every trace of <paramref name="key"/> from the index — rows and
    /// registration alike, the inverse of <see cref="Index"/>. ADR-0001: this is the
    /// <b>file-gone</b> verb — a delete, an uninstall, a file missing at validation — never the
    /// meaning of a copy leaving the load order, which is <see cref="Unregister"/>.</summary>
    void Unindex(PluginKey key);

    /// <summary>ADR-0001: registration is visibility. Writes <paramref name="key"/>'s
    /// <c>registrations</c> row — the whole of its membership in the load order — so its
    /// already-indexed rows answer again on every read path and every generated view, with no
    /// re-index. An upsert: re-registering a held copy with a different <see cref="Registration"/>
    /// (a reorder, an enable, a change of which copy wins) is how ADR-0044's reconcile moves it,
    /// SQL-only. Winner state is stale until the next <see cref="UpdateWinners"/> sweep.
    /// (<see cref="Index"/> registers as part of indexing; this is the verb for rows the index
    /// already holds.)</summary>
    void Register(PluginKey key, Registration registration);

    /// <summary>ADR-0044: every copy the index currently registers, in no particular order. What a
    /// reconcile diffs the incoming snapshot against — a freshly opened index file still carries
    /// the registrations the last run left (ADR-0001 point 4, amended), and this is how they are
    /// found and corrected rather than cleared.</summary>
    IReadOnlyList<PluginKey> RegisteredPlugins();

    /// <summary>Removes <paramref name="key"/>'s <c>registrations</c> row and nothing else: its rows
    /// remain in the index and answer nothing on any path — ADR-0035's "hidden means absent" is
    /// <i>unregistered, never answering</i>. Winner state is stale until the next
    /// <see cref="UpdateWinners"/> sweep.</summary>
    void Unregister(PluginKey key);

    /// <summary>Rebuilds the whole load order's winners — which plugin's copy of each FormKey holds
    /// the field, at each ref. ADR-0001: that answer lives in a load-order-owned derived
    /// table, not in a column on any indexed row, so this replaces the table rather than updating
    /// rows in place. Every read still spells it <c>is_winner</c>, projected by the view. Only
    /// participating registrations (<see cref="Registration.Participates"/>) compete.</summary>
    void UpdateWinners();

    /// <summary>
    /// Folds a plugin's working-tree source changes into the read model, which is what makes
    /// <see cref="RecordRef.Effective"/> and <see cref="RecordRef.Head"/> diverge. Each delta is a
    /// record's source file as it now stands: <paramref name="deltas"/>' <c>Body</c> is the file's
    /// exact bytes, and a <see langword="null"/> <c>Body</c> is that record's <i>deletion</i> from
    /// the working tree — the record keeps answering at Head, and stops existing at Effective.
    ///
    /// <para>A body that is byte-equal to the committed one is not a change at all but a
    /// <i>convergence</i>: the record goes clean again, exactly as if it had never been edited. That
    /// is what makes reverting a source file through git (or editing a value back by hand) restore
    /// the committed state rather than leave a permanently "dirty" record holding identical bytes —
    /// byte compare is the detection, never a <c>content_hash</c> mismatch on
    /// its own.</para>
    ///
    /// <para>Idempotent, and safe to call with deltas for records this plugin does not hold: an
    /// unknown FormKey is skipped, not thrown on (the seam's missing-data rule). Creating a record
    /// that exists at neither ref is not expressible here — that is <see cref="CreateWorkingTreeRecord"/>,
    /// its own method rather than a widened delta shape, because this method's whole contract (byte-compare
    /// convergence against a fixed baseline, snapshot-on-first-divergence) presupposes a baseline that a
    /// create does not have.</para>
    ///
    /// <para><b>No external-change deferral check lives here, deliberately.</b> This method has
    /// two legitimate callers: <c>Edits.RecordEditService</c> (an actual write gesture) and
    /// <c>Source.SourceFreshness</c>'s read-time self-heal, which must keep folding in whatever the
    /// source file already says even while a plugin's external-change question is unanswered — exit
    /// path 3's contract is "reads continue serving last-known state" while deferred, and a guard
    /// here would block reads, which are not editing. The deferral refusal is enforced at
    /// <c>RecordEditService</c>'s own entry points instead (see its doc comment); every new write
    /// gesture must enter through <c>RecordEditService</c>, never call this method (or
    /// <see cref="CreateWorkingTreeRecord"/>) directly, to inherit that refusal — this namespace must
    /// not learn Source's vocabulary (deferral, tracked, external change) either way. Both methods
    /// carry this same signpost so a caller reading either one learns the rule.</para>
    /// </summary>
    void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas);

    /// <summary>
    /// Materializes a record that exists at <b>neither</b> ref — the one case
    /// <see cref="ApplyWorkingTreeChanges"/> deliberately refuses to express. Inserts one row directly
    /// with <c>ref = working-tree</c> and no <c>records_committed</c> counterpart, which is what makes
    /// it answer at <see cref="RecordRef.Effective"/> and stay absent at <see cref="RecordRef.Head"/>
    /// for free, given how <c>records_head</c> is already defined (union of diverged snapshots with
    /// still-clean committed rows) — nothing about that view needed to change for creation to fall out
    /// of it. Also derives <c>form_lookup</c>/<c>form_references</c> for the new record and re-sweeps
    /// winners (a create is always structural — a row that did not exist now does), the same way
    /// <see cref="ApplyWorkingTreeChanges"/> does for an ordinary structural delta.
    ///
    /// <para>Throws <see cref="ArgumentException"/> if <paramref name="key"/> already holds
    /// <paramref name="formKey"/> at either ref — the caller (FormKey allocation, collision checking)
    /// owns picking a FormKey nothing already answers to; this method only refuses to silently
    /// overwrite one that does.</para>
    ///
    /// <para><b>No external-change deferral check lives here, deliberately</b> — the same
    /// signpost <see cref="ApplyWorkingTreeChanges"/> carries. <c>Edits.RecordEditService.CreateRecord</c>
    /// is the write gesture, and every new write gesture must enter through
    /// <c>Edits.RecordEditService</c> to inherit the deferral/untracked refusals — never call this
    /// method directly for a gesture. Enforcing those guards here would block a path where they mean
    /// nothing.</para>
    ///
    /// <para>Reaching the same end state from the other direction — a record the
    /// ingest already saw, which no commit holds — is <see cref="MarkWorkingTreeOnly"/>.</para>
    /// </summary>
    void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body);

    /// <summary>
    /// Re-establishes what "committed" <i>means</i> for these records — <c>HEAD</c> has moved
    /// under the working tree (a commit, rebase, amend or checkout the user made outside Modbench,
    /// which is ordinary git fluency and tolerated by construction, ADR-0041).
    ///
    /// <para>The sibling of <see cref="ApplyWorkingTreeChanges"/>, and needed because that method
    /// cannot express this: it moves the Effective side against a fixed baseline, while this moves
    /// the baseline itself. A record whose Effective bytes equal its new baseline is clean again by
    /// the same byte compare everything else here uses — which is what makes an external commit read
    /// as "committed" rather than as dirt against a baseline no ref holds any more.</para>
    ///
    /// <para>Records the plugin does not hold are skipped, not thrown on.</para>
    /// </summary>
    void SetCommittedBaseline(PluginKey key, IReadOnlyList<(string FormKey, string Body)> baselines);

    /// <summary>
    /// Says that these already-ingested records exist in the working tree but at <b>no</b>
    /// committed ref — they stop answering at <see cref="RecordRef.Head"/> and keep answering at
    /// <see cref="RecordRef.Effective"/>, which is <see cref="CreateWorkingTreeRecord"/>'s end state
    /// reached from the other direction.
    ///
    /// <para>Needed because ingest-from-source seeds both refs from one whole-tree read, so a record
    /// the user created and never committed arrives looking committed. Neither existing verb can say
    /// this: <see cref="SetCommittedBaseline"/> moves <i>which bytes</i> Head holds and cannot say Head
    /// holds none, and <see cref="CreateWorkingTreeRecord"/> refuses outright for a FormKey some ref
    /// already answers to — which, after that whole-tree read, is every record in the plugin.</para>
    ///
    /// <para>Records the plugin does not hold are skipped, not thrown on — the seam's missing-data
    /// rule, same as <see cref="SetCommittedBaseline"/>. Idempotent: a record already answering at
    /// Effective only is left exactly as it is.</para>
    /// </summary>
    void MarkWorkingTreeOnly(PluginKey key, IReadOnlyList<string> formKeys);

    /// <summary>
    /// Seeds a record that exists at <c>HEAD</c> but <b>not</b> in the working tree — the mirror
    /// of <see cref="MarkWorkingTreeOnly"/>, and the deletion half of the ref dimension. It answers at
    /// <see cref="RecordRef.Head"/> and is absent at <see cref="RecordRef.Effective"/>, so a user can
    /// still see, diff and revert what they deleted rather than having it vanish from both refs at the
    /// next reconcile (ADR-0041's git-native working-tree model).
    ///
    /// <para>Needed for the same reason as its mirror: a whole-tree read of the working tree cannot
    /// produce a row for a file that is not in it, and <see cref="ApplyWorkingTreeChanges"/>' deletion
    /// delta presupposes an Effective row to snapshot aside, which a fresh ingest never created.</para>
    ///
    /// <para>Writes no <c>form_lookup</c>, <c>form_references</c> or other extracted rows,
    /// deliberately: those tables carry no ref dimension and track Effective (a FormKey resolves to
    /// what the link points at <i>now</i>) — the same rule <c>records_head</c>'s own definition already
    /// states for the reads that answer from them.</para>
    ///
    /// <para>Skipped rather than thrown on when the plugin already holds a listed FormKey at either
    /// ref: this is only ever for a record the working tree genuinely does not have.</para>
    ///
    /// <para>Batched, like <see cref="SetCommittedBaseline"/> and <see cref="MarkWorkingTreeOnly"/>: the
    /// three head-state writes are the reconciliation pass's whole output, and applying them
    /// all-or-nothing is what keeps a pass that throws partway from leaving Head half-moved.</para>
    /// </summary>
    void SeedCommittedOnly(PluginKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records);

    /// <summary>
    /// Replaces every <c>container_child</c> row for one (<paramref name="parentFormKey"/>,
    /// <paramref name="slotName"/>) folder-split slot with exactly <paramref name="children"/> — the
    /// counterpart to <see cref="MEditService.Core.Source.SourceChildOrder"/> for a slot whose child
    /// <i>set</i> a delete or renumber changed. A folder-split child (a Quest's DialogTopic, a
    /// DialogTopic's Response) has no file of its own the parent's document embeds
    /// (<see cref="ApplyWorkingTreeChanges"/>'s own re-derivation only reaches an <b>embedded</b>
    /// child's parent body), so its position has to be told here rather than re-read from a
    /// reserialized owner.
    ///
    /// <para>A full delete-then-insert, matching every other extracted-table rebuild in this
    /// interface: a removed child's row disappears for free because it is simply absent from
    /// <paramref name="children"/>, and no caller has to diff against what was there before.</para>
    /// </summary>
    void ReplaceContainerChildSlot(
        PluginKey key, string parentFormKey, string parentRecordType, string slotName,
        IReadOnlyList<(string ChildFormKey, int SlotIndex)> children);

    /// <summary>
    /// The whole index side of a renumber, applied all-or-nothing (#677): the new identity's rows
    /// are materialized, everything still naming the old identity as its parent is re-pointed onto
    /// the new one, and the old identity's rows are torn down. One transaction, so a fault anywhere
    /// in that sequence leaves the index exactly as it found it rather than half-moved — a new
    /// FormKey present that no source file backs, or children orphaned onto a parent that was never
    /// torn down.
    ///
    /// <para><b>One composite, not a transaction primitive.</b> This seam deliberately exposes
    /// neither a connection nor a transaction (ADR-0005: the relational schema is a contract for
    /// <i>the SQL door only</i>, not a handle callers steer). A renumber is one domain gesture, so it
    /// is one verb; the steps below are its internals, not a script a caller assembles.</para>
    ///
    /// <para><b>The re-points are the two things a re-derivation structurally cannot reach.</b>
    /// Re-deriving the renumbered record's own new document from <paramref name="renumbered"/>'s body
    /// recreates only what is <i>embedded</i> in it (<see cref="Source.ContainerChildFields"/>'s own
    /// doc comment). It therefore cannot recreate a folder-split child's <c>container_child</c> row —
    /// a renumbered Quest's DialogTopics, a renumbered DialogTopic's Responses keep their own
    /// FormKeys and their own files, only the parent's directory name having moved — nor an exterior
    /// cell's <c>cell_location.parent_worldspace</c>, since <c>Worldspace.SubCells</c> holds
    /// <c>WorldspaceBlock</c>, which is not
    /// <see cref="Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter"/>, so the re-derivation only
    /// ever recurses one level, into <c>TopCell</c>. Both re-points are scoped to exactly the one
    /// column a rename invalidates for a record's own children, and both match zero rows for a
    /// renumbered record that has none — which is every type other than a container and a Worldspace
    /// respectively.</para>
    ///
    /// <para><b>Neither re-point contends with the re-derivation for a Worldspace's own
    /// <c>TopCell</c>.</b> That row is rewritten by a delete-then-insert keyed on the cell's own
    /// unchanging <c>cell_form_key</c>, never on <c>parent_worldspace</c> — so it is replaced whole
    /// regardless of which parent it currently names, and is never left behind for the re-point's
    /// <c>WHERE parent_worldspace = old</c> to match a second time. Exactly one row, never two.</para>
    ///
    /// <para>Throws <see cref="ArgumentException"/> if <paramref name="key"/> already holds
    /// <see cref="RenumberedRecord.NewFormKey"/> at either ref — the same refusal
    /// <see cref="CreateWorkingTreeRecord"/> makes, for the same reason, and made before the
    /// transaction opens so a collision costs no rollback.</para>
    ///
    /// <para><b>No external-change deferral check lives here</b> — the same signpost
    /// <see cref="ApplyWorkingTreeChanges"/> and <see cref="CreateWorkingTreeRecord"/> carry.
    /// <c>Edits.RecordEditService.RenumberRecord</c> is the write gesture and owns those refusals.</para>
    /// </summary>
    void ApplyRenumber(PluginKey key, RenumberedRecord renumbered);

    /// <summary>
    /// Gives a cell its own <c>cell_location</c> row directly, copied from wherever the caller
    /// already has it (typically the source plugin's own <see cref="IRecordReads.GetCellLocation"/>
    /// answer for the same FormKey) — a copy-in, never a derivation. Every existing write of this
    /// table (<c>DuckDbRecordIndex.RederiveContainmentForRecord</c>) only ever re-derives a
    /// <c>Worldspace.TopCell</c>'s row from its parent's freshly-reserialized document; a genuine
    /// exterior cell reached through <c>SubCells</c> is never that document's embedded child
    /// (<c>Source.ContainerChildFields</c>'s own doc comment — <c>WorldspaceBlock</c> is not
    /// <see cref="Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter"/>), so nothing today can ever
    /// produce its row from a record body alone. This is that missing write, for the one caller that
    /// already knows the row's exact values because it just read them off the source.
    ///
    /// <para>Delete-then-insert for <paramref name="row"/>'s own <c>CellFormKey</c>, matching every
    /// other single-row rebuild in this table (<c>RederiveContainmentForRecord</c>'s own
    /// <c>TopCell</c> write) — safe to call again for the same cell (e.g. a retried or re-applied
    /// copy) without leaving a duplicate row behind.</para>
    /// </summary>
    void CreateCellLocation(PluginKey plugin, CellLocationRow row);

    /// <summary>
    /// Materializes a <c>_filter</c> table from <paramref name="sql"/> (null clears it) — the one
    /// door SQL crosses this seam through, since it is itself a published contract for user filter
    /// SQL (ADR-0041). Throws <see cref="ArgumentException"/> if the SQL doesn't return a
    /// <c>form_key</c> column; state is unchanged on failure.
    /// </summary>
    void SetFilter(string? sql);
}

/// <summary>
/// Everything <see cref="IRecordIndex.ApplyRenumber"/> needs to move a record from one identity to
/// another: the FormKey it had, the FormKey it now has, and the bytes that back the new one.
///
/// <para><b><paramref name="Owner"/> is what distinguishes the two shapes a renumber has.</b> A
/// record with a source file of its own carries none — its own <paramref name="Body"/> is the whole
/// story, and the re-points cover the children that file's document cannot describe. An
/// <i>embedded</i> record has no file of its own: its fields live inside its owner's document, so
/// the owner is reserialized too and arrives here alongside the child. Nothing is re-pointed on that
/// path, because an embedded record's containment is entirely re-derived from that owner body.</para>
///
/// <para>One nullable <see cref="EmbeddingOwner"/> rather than a nullable FormKey beside a nullable
/// body: "both or neither" is then the type's own shape rather than a rule a doc comment asks
/// callers to keep.</para>
/// </summary>
/// <param name="OldFormKey">The identity being vacated — its rows are torn down last.</param>
/// <param name="NewFormKey">The identity being taken. Must be held at neither ref.</param>
/// <param name="RecordType">The renumbered record's type, for the new row.</param>
/// <param name="Body">The renumbered record's own new document.</param>
/// <param name="Owner">The document the renumbered record is embedded in, or <c>null</c> when it has
/// a source file of its own.</param>
public sealed record RenumberedRecord(
    string OldFormKey,
    string NewFormKey,
    string RecordType,
    string Body,
    EmbeddingOwner? Owner = null);

/// <summary>The reserialized document an embedded renumbered record lives inside, and the FormKey
/// whose row carries it.</summary>
public sealed record EmbeddingOwner(string FormKey, string Body);
