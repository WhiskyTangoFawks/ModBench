using MEditService.Index;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Queries;

/// <summary>ADR-0012 invariant 1: naming a plugin without its origin names half an identity.
/// Shared so no caller's own copy of this check can drift from another's.</summary>
public static class RecordFilterGuard
{
    public static bool NamesOnlyPluginOrOnlyOrigin(string? plugin, string? origin) =>
        string.IsNullOrWhiteSpace(plugin) != string.IsNullOrWhiteSpace(origin);
}

public interface IRecordQueryService
{
    IReadOnlyList<PluginRow> GetPlugins();
    // plugin/origin (ADR-0012 invariant 1): both null browses every plugin; naming one names the
    // other too — a plugin filter with no origin would match every plugin sharing that filename.
    PagedResult<RecordSummary> GetRecords(
        string? type, string? plugin, string? search, int limit, int offset, string? origin = null, bool unfiltered = false);
    RecordDetail? GetRecord(string formKey);

    CompareResult? GetCompare(string formKey);

    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string origin);
    IReadOnlyList<CreatableRecordType> GetCreatableRecordTypes();
    // Mutagen's release data (GameConstants.SmallMasterFlag), not a per-game table — the one
    // source create-plugin's name prompt and CreatePluginHandler's refusal both read.
    bool GetLightPluginsSupported();
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    // ADR-0013 invariant 4: answered in every state, "no load order yet" included.
    LoadOrderStatus GetStatus();
    long GetSequence();
    Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout);

    (string Sql, string Source)? GetFilter();
    void SetFilter(string sql, string source);
    void ClearFilter();
    Task RebuildStore(GameRelease gameRelease, string instanceRoot);
}
