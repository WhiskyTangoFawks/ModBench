using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>Ingest plus every read, over one game's indexed plugins. One implementation over DuckDB;
/// no SQL crosses this seam except <see cref="SetFilter"/> (invariant 8).</summary>
internal interface IRecordIndex : IDisposable
{
    /// <summary>Repositions every read at <paramref name="recordRef"/>. Named <c>recordRef</c>, not
    /// <c>ref</c>: CA1716 rejects an interface parameter named after a reserved keyword, even
    /// escaped.</summary>
    IRecordReads At(RecordRef recordRef);

    void Initialize(GameRelease release);

    /// <summary>ADR-0046: one monotonic counter, advanced in the same transaction as any row
    /// change — ingest, a working-tree push, a registration or a winner sweep. Zero until the
    /// first change lands.</summary>
    long Sequence { get; }

    /// <summary>ADR-0046: everything projected inside the scope advances <see cref="Sequence"/> once,
    /// when the outermost scope closes, so a whole-plugin projection and a settled batch are each
    /// one advance. Nested scopes count.</summary>
    IDisposable BeginProjection();

    /// <summary>Runs <paramref name="publish"/> once the projection it was raised in has landed:
    /// immediately outside a scope, after that scope's advance inside one.</summary>
    void Announce(Action publish);

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

    /// <summary>Materializes a <c>_filter</c> table from <paramref name="sql"/> (null clears it) — the
    /// one door SQL crosses this seam through (ADR-0041). Throws if the SQL returns no
    /// <c>form_key</c> column; state is unchanged on failure.</summary>
    void SetFilter(string? sql);

    /// <summary>ADR-0046: the one projection verb. Re-derives <paramref name="formKeys"/>' rows at
    /// both refs from the Source repository, idempotent by content. A key held at neither ref
    /// re-derives the whole copy.</summary>
    void RefreshByKeys(PluginKey key, string modFolder, IReadOnlyList<string> formKeys);

    /// <summary>ADR-0046 invariant 6: compares <paramref name="key"/>'s rows against the system of
    /// record they came from — source documents at both refs for a tracked
    /// <paramref name="modFolder"/>, the binary otherwise — and refreshes what differs.</summary>
    ValidationReport Validate(PluginKey key, string? modFolder);
}
