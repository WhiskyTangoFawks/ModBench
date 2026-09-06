using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>Ingest plus every read, over one game's indexed plugins. One implementation over DuckDB;
/// no SQL crosses this seam except <see cref="SetFilter"/> (invariant 8).</summary>
public interface IRecordIndex : IDisposable
{
    /// <summary>Repositions every read at <paramref name="recordRef"/>. Named <c>recordRef</c>, not
    /// <c>ref</c>: CA1716 rejects an interface parameter named after a reserved keyword, even
    /// escaped.</summary>
    IRecordReads At(RecordRef recordRef);

    void Initialize(GameRelease release);

    /// <summary>Indexes one plugin file, replacing whatever <paramref name="key"/> held. ADR-0001:
    /// <paramref name="filePath"/> is stamped with its content hash so the rows are validatable at
    /// the next open; omitting it claims no file backs them.</summary>
    void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null);

    /// <summary>The hash of the file <paramref name="key"/>'s rows were built from, or null when the
    /// index holds no validated rows for it. Independent of registration, so a returning profile
    /// switch is cheap (ADR-0001).</summary>
    string? IndexedContentHash(PluginKey key);

    /// <summary>Removes every trace of <paramref name="key"/>, rows and registration alike. ADR-0001:
    /// the file-gone verb — never the meaning of a copy leaving the load order, which is
    /// <see cref="Unregister"/>.</summary>
    void Unindex(PluginKey key);

    /// <summary>ADR-0001: registration is visibility. Writes <paramref name="key"/>'s
    /// <c>registrations</c> row so its already-indexed rows answer again with no re-index; an
    /// upsert. Winner state is stale until the next sweep.</summary>
    void Register(PluginKey key, Registration registration);

    /// <summary>ADR-0044: every copy the index currently registers — what a reconcile diffs the
    /// incoming snapshot against, since a freshly opened file still carries the last run's
    /// registrations.</summary>
    IReadOnlyList<PluginKey> RegisteredPlugins();

    /// <summary>Removes <paramref name="key"/>'s <c>registrations</c> row and nothing else: its rows
    /// remain and answer nothing (ADR-0035's "hidden means absent"). Winner state is stale until
    /// the next sweep.</summary>
    void Unregister(PluginKey key);

    /// <summary>Rebuilds the whole load order's winners at each ref. ADR-0001: the answer lives in a
    /// load-order-owned table, so this replaces it rather than updating rows in place. Only
    /// participating registrations compete.</summary>
    void UpdateWinners();

    /// <summary>Folds working-tree changes into the read model: null Body deletes, byte-equal body
    /// converges. No deferral check here: read-time self-heal must keep folding source in while an
    /// external-change question is open.</summary>
    void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas);

    /// <summary>Materializes a record that exists at neither ref, the one case
    /// <see cref="ApplyWorkingTreeChanges"/> refuses to express. Throws ArgumentException if
    /// <paramref name="key"/> already holds <paramref name="formKey"/> at either ref.</summary>
    void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body);

    /// <summary>Re-establishes what "committed" means for these records after <c>HEAD</c> moved under
    /// the working tree (a commit, rebase or checkout made outside Modbench, ADR-0041). Records the
    /// plugin does not hold are skipped.</summary>
    void SetCommittedBaseline(PluginKey key, IReadOnlyList<(string FormKey, string Body)> baselines);

    /// <summary>These already-ingested records exist at no committed ref. Needed because
    /// ingest-from-source seeds both refs from one whole-tree read, so an uncommitted record arrives
    /// looking committed. Idempotent; unknown records are skipped.</summary>
    void MarkWorkingTreeOnly(PluginKey key, IReadOnlyList<string> formKeys);

    /// <summary>Seeds a record at <c>HEAD</c> but not in the working tree, so the user can see and
    /// diff a deletion (ADR-0041). Writes no extracted rows: those track Effective. Skipped when
    /// held at either ref.</summary>
    void SeedCommittedOnly(PluginKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records);

    /// <summary>One transaction for a record with a file of its own: materialize the new identity,
    /// re-point exterior cells, tear the old down. An embedded record renumbers through its owner's
    /// document.</summary>
    void ApplyRenumber(PluginKey key, RenumberedRecord renumbered);

    /// <summary>Gives a cell a <c>cell_location</c> row copied from wherever the caller has it — never
    /// a derivation, since an exterior cell reached through <c>SubCells</c> is never a document's
    /// embedded child. Delete-then-insert.</summary>
    void CreateCellLocation(PluginKey plugin, CellLocationRow row);

    /// <summary>Materializes a <c>_filter</c> table from <paramref name="sql"/> (null clears it) — the
    /// one door SQL crosses this seam through (ADR-0041). Throws if the SQL returns no
    /// <c>form_key</c> column; state is unchanged on failure.</summary>
    void SetFilter(string? sql);
}

/// <summary>What <see cref="IRecordIndex.ApplyRenumber"/> needs.</summary>
public sealed record RenumberedRecord(string OldFormKey, string NewFormKey, string RecordType, string Body);
