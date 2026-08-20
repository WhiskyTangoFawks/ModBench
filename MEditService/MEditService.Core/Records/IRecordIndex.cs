using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// The Index (glossary sense): ingest plus every read, over one game/session's worth of indexed
/// plugins. Replaces <c>IRecordRepository</c>/<c>IRecordReader</c>/<c>IRecordIndexer</c> (#421) and
/// absorbs the read-model pass-throughs <c>IRecordQueryService</c> used to carry purely to forward
/// here (<c>GetRecordForPlugin</c>/<c>GetRecordType</c>/<c>GetNativeFormKeys</c>/<c>GetPlacement</c>/
/// <c>GetVmad</c>/<c>GetConditions</c> — all endpoint-orphaned, deleted rather than kept as
/// redundant forwarding). One implementation over DuckDB; no ports, no test double.
///
/// No <c>Connection</c> property and no SQL crosses this seam except <see cref="SetFilter"/>
/// (invariant 8).
/// </summary>
public interface IRecordIndex : IRecordReads, IDisposable
{
    /// <summary>Repositions every <see cref="IRecordReads"/> read at <paramref name="recordRef"/>.
    /// #421 ships <see cref="RecordRef.Head"/> answering identically to the default
    /// <see cref="RecordRef.Effective"/> surface (the git-ref case is a later, additive addition);
    /// #415 is what makes them diverge. (Named <c>recordRef</c> rather than the pinned contract's
    /// literal <c>ref</c>/<c>@ref</c>: CA1716 rejects a virtual/interface parameter named after the
    /// reserved keyword even escaped.)</summary>
    IRecordReads At(RecordRef recordRef);

    void Initialize(GameRelease release);

    /// <summary>Indexes one physical plugin file's records, header, references, form_lookup and
    /// placement, replacing whatever <paramref name="key"/> previously held (#413/#420: one
    /// document per major record plus the extracted index tables derived from it).</summary>
    void Index(IModGetter plugin, int loadOrderIndex, bool participates, PluginKey key);

    /// <summary>Removes every trace of <paramref name="key"/> from the read model — the inverse of
    /// <see cref="Index"/> (#34/ADR-0035's "hidden means absent").</summary>
    void Unindex(PluginKey key);

    /// <summary>Recomputes <c>is_winner</c> across every indexed table for the whole session.</summary>
    void UpdateWinners();

    /// <summary>Flips an already-indexed plugin's participation flag — SQL-only, no re-index.
    /// Winner state is stale until the next <see cref="UpdateWinners"/> sweep.</summary>
    void SetPluginParticipation(PluginKey key, bool participates);

    /// <summary>
    /// #415: folds a plugin's working-tree ledger changes into the read model, which is what makes
    /// <see cref="RecordRef.Effective"/> and <see cref="RecordRef.Head"/> diverge. Each delta is a
    /// record's ledger file as it now stands: <paramref name="deltas"/>' <c>Body</c> is the file's
    /// exact bytes, and a <see langword="null"/> <c>Body</c> is that record's <i>deletion</i> from
    /// the working tree — the record keeps answering at Head, and stops existing at Effective.
    ///
    /// <para>A body that is byte-equal to the committed one is not a change at all but a
    /// <i>convergence</i>: the record goes clean again, exactly as if it had never been edited. That
    /// is what makes reverting a ledger file through git (or editing a value back by hand) restore
    /// the committed state rather than leave a permanently "dirty" record holding identical bytes —
    /// byte compare is the detection, per #413's contract, never a <c>content_hash</c> mismatch on
    /// its own.</para>
    ///
    /// <para>Idempotent, and safe to call with deltas for records this plugin does not hold: an
    /// unknown FormKey is skipped, not thrown on (the seam's missing-data rule). Creating a record
    /// that exists at neither ref is not expressible here — it is a lifecycle gesture with its own
    /// ticket.</para>
    /// </summary>
    void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas);

    /// <summary>
    /// Materializes a <c>_filter</c> table from <paramref name="sql"/> (null clears it) — the one
    /// door SQL crosses this seam through, since it is itself a published contract for user filter
    /// SQL (ADR-0041). Throws <see cref="ArgumentException"/> if the SQL doesn't return a
    /// <c>form_key</c> column; state is unchanged on failure.
    /// </summary>
    void SetFilter(string? sql);
}
