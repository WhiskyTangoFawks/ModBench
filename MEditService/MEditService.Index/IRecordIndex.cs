using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Ingest plus every read, over one game's indexed plugins. One implementation over DuckDB;
/// no SQL crosses this seam except <see cref="SetFilter"/>.</summary>
internal interface IRecordIndex : IDisposable
{
    /// <summary>Repositions every read at <paramref name="recordRef"/>. Named <c>recordRef</c>, not
    /// <c>ref</c>: CA1716 rejects an interface parameter named after a reserved keyword, even
    /// escaped.</summary>
    IRecordReads At(RecordRef recordRef);

    /// <summary>Where <see cref="IRecordReads.OpenedPlugins"/> reads from. The store holds no header
    /// flag, master list or record count, so the Indexer points it at the plugins it holds
    /// open.</summary>
    void ReadOpenedPluginsFrom(Func<IReadOnlyDictionary<PluginAddress, PluginContent>> opened);

    void Initialize(GameRelease release);

    /// <summary>ADR-0015: one monotonic counter, advanced in the same transaction as
    /// any row change — ingest, a working-tree push, a registration or a winner sweep. Zero until
    /// the first change lands.</summary>
    long Sequence { get; }

    /// <summary>ADR-0015: everything projected inside the scope advances
    /// <see cref="Sequence"/> once, when the outermost scope closes, so a whole-plugin projection
    /// and a snapshot's validation are each one advance. Nested scopes count.</summary>
    IDisposable BeginProjection();

    /// <summary>Runs <paramref name="publish"/> once the projection it was raised in has landed:
    /// immediately outside a scope, after that scope's advance inside one.</summary>
    void Announce(Action publish);

    /// <summary>Indexes one plugin's documents, replacing whatever the key held. Stamps the file's
    /// hash and diagnosis (ADR-0003); a null path claims no file backs the rows.</summary>
    void Index(IPluginDocuments documents, Registration registration, PluginAddress key, string? filePath, DerivedFrom derivedFrom);

    /// <summary>The hash of the file <paramref name="key"/>'s rows were built from, or null when the
    /// index holds no validated rows for it. Independent of registration, so a returning profile
    /// switch is cheap (ADR-0012).</summary>
    string? IndexedContentHash(PluginAddress key);

    /// <summary>The hash of the file at <paramref name="path"/> now (ADR-0003). Null when the file
    /// cannot be read.</summary>
    string? FileContentHash(string path);

    /// <summary>Removes every trace of <paramref name="key"/>, rows and registration alike. ADR-0012's file-gone verb — never the meaning of a plugin leaving the load order, which is
    /// <see cref="Unregister"/>.</summary>
    void Unindex(PluginAddress key);

    /// <summary>Upserts <paramref name="key"/>'s <c>registrations</c> row: its indexed facts answer
    /// with no re-index (ADR-0012), its records too when it is active. Winners stay stale until the
    /// next sweep.</summary>
    void Register(PluginAddress key, Registration registration);

    /// <summary>ADR-0013: every plugin the index currently registers — what a reconcile diffs the
    /// incoming snapshot against, since a freshly opened file still carries the last run's
    /// registrations.</summary>
    IReadOnlyList<PluginAddress> RegisteredPlugins();

    /// <summary>Removes <paramref name="key"/>'s <c>registrations</c> row and nothing else: its rows
    /// remain and answer nothing. Winner state is stale until the next sweep.</summary>
    void Unregister(PluginAddress key);

    /// <summary>Rebuilds every ref's winners among <paramref name="active"/>, in load order
    /// (ADR-0013), remembered for the re-sweeps a working-tree write triggers.</summary>
    void UpdateWinners(IReadOnlyList<RegisteredPlugin> active);

    /// <summary>Re-establishes what "committed" means for these records after <c>HEAD</c> moved under
    /// the working tree (a commit, rebase or checkout made outside Modbench, ADR-0007).
    /// Records the plugin does not hold are skipped.</summary>
    void SetCommittedBaseline(PluginAddress key, IReadOnlyList<(string FormKey, string Body)> baselines);

    /// <summary>These already-ingested records exist at no committed ref. Needed because
    /// ingest-from-source seeds both refs from one whole-tree read, so an uncommitted record arrives
    /// looking committed. Idempotent; unknown records are skipped.</summary>
    void MarkWorkingTreeOnly(PluginAddress key, IReadOnlyList<string> formKeys);

    /// <summary>Seeds a record at <c>HEAD</c> but not in the working tree, so the user can see and
    /// diff a deletion (ADR-0007). Writes no extracted rows: those track Effective. Skipped when
    /// held at either ref.</summary>
    void SeedCommittedOnly(PluginAddress key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records);

    /// <summary>Materializes <paramref name="sql"/>'s matches and the records holding them (null
    /// clears both), the one door SQL crosses this seam through. Throws if
    /// the SQL returns no <c>form_key</c> column.</summary>
    void SetFilter(string? sql);

    /// <summary>ADR-0015: the one projection verb. Re-derives <paramref name="formKeys"/>' rows at
    /// both refs from the Source repository, idempotent by content. A key held at neither ref
    /// re-derives the whole plugin.</summary>
    void RefreshByKeys(PluginAddress key, string modFolder, IReadOnlyList<string> formKeys);

    /// <summary>ADR-0015: compares <paramref name="key"/>'s rows against the system of
    /// record they came from — source documents at both refs when <paramref name="modFolder"/> holds
    /// its tree, the binary otherwise — and refreshes what differs.</summary>
    ValidationReport Validate(PluginAddress key, string? modFolder);
}
