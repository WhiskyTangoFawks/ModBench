using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Ingest plus every read, over one game's indexed plugins. One implementation over DuckDB;
/// no SQL crosses this seam except <see cref="SetFilter"/>.</summary>
internal interface IRecordIndex : IDisposable
{
    /// <summary>Every read the index answers.</summary>
    IRecordReads Reads { get; }

    /// <summary>Where <see cref="IRecordReads.OpenedPlugins"/> reads from. The store holds no header
    /// flag, master list or record count, so the Indexer points it at the plugins it holds
    /// open.</summary>
    void ReadOpenedPluginsFrom(Func<IReadOnlyDictionary<PluginAddress, PluginContent>> opened);

    /// <summary>The refusal when another window holds the instance's index file, which leaves the
    /// index unusable (ADR-0010). Null otherwise.</summary>
    string? HeldElsewhere { get; }

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

    /// <summary>Rebuilds the winners among <paramref name="active"/>, in load order
    /// (ADR-0013), remembered for the re-sweeps a working-tree write triggers.</summary>
    void UpdateWinners(IReadOnlyList<RegisteredPlugin> active);

    /// <summary>Sets each of <paramref name="key"/>'s rows to how the Source repository says its record
    /// stands against the last commit (ADR-0007). Returns the keys that moved, for the caller to
    /// announce.</summary>
    IReadOnlyList<string> LearnWorkingTreeStates(PluginAddress key, string modFolder);

    /// <summary>Materializes <paramref name="sql"/>'s matches and the records holding them (null
    /// clears both), the one door SQL crosses this seam through. Throws if
    /// the SQL returns no <c>form_key</c> column.</summary>
    void SetFilter(string? sql);

    /// <summary>ADR-0015: the one projection verb. Re-derives <paramref name="formKeys"/>' rows
    /// from the Source repository, idempotent by content. A key the index does not hold re-derives
    /// the whole plugin.</summary>
    void RefreshByKeys(PluginAddress key, string modFolder, IReadOnlyList<string> formKeys);

    /// <summary>ADR-0015: compares <paramref name="key"/>'s rows against the system of
    /// record they came from — source documents when <paramref name="modFolder"/> holds
    /// its tree, the binary otherwise — and refreshes what differs.</summary>
    ValidationReport Validate(PluginAddress key, string? modFolder);
}
