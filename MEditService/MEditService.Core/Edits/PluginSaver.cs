using MEditService.Core.Session;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Edits;

/// <summary>
/// A reindex that failed after the file and DB commit already succeeded. The save is done and
/// pending changes are consumed; only the read model is stale. Named and structured per
/// <c>MEditService/CLAUDE.md</c> / ADR-0026 — never a thrown exception, never stringly-typed.
/// </summary>
public sealed record ReindexFailure(IReadOnlyList<string> Plugins, string Reason);

public abstract record SaveGroupResult
{
    public sealed record NoChanges : SaveGroupResult;
    public sealed record Saved(
        IReadOnlyDictionary<string, SaveResult> ByPlugin,
        ReindexFailure? ReindexFailure = null) : SaveGroupResult;
    public sealed record ImmutablePlugin(string Plugin) : SaveGroupResult;
}

public sealed class PluginSaver(IPendingChangeService changes, ISessionManager session, ILogger<PluginSaver> logger)
{
    public async Task<SaveGroupResult> Save(Guid memberChangeId)
    {
        var s = session.Session;
        if (s != null)
        {
            // #306: null (no load-order member of this name) refuses here too — proceeding would
            // only fail later, inside SessionManager.RequirePlugin's KeyNotFoundException.
            var refusedPlugin = changes.GetChanges(memberChangeId: memberChangeId)
                .Select(c => c.Plugin)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault(plugin => s.LoadOrderPlugin(plugin) is not { IsImmutable: false });
            if (refusedPlugin != null)
                return new SaveGroupResult.ImmutablePlugin(refusedPlugin);
        }

        // #272 / ADR-0036: byColumn is keyed by the compound column identity, not the bare plugin —
        // the real plugin filename to write/reindex is recovered from the group's own
        // PendingChange.Plugin (never by parsing the compound key) and captured here as
        // writtenPlugins, since saved.ByPlugin's own keys are compound from this point on.
        var writtenPlugins = new List<string>();
        var result = await changes.ExecuteGroupSaveAsync(memberChangeId, async byColumn =>
        {
            var prepared = new List<(string Column, PreparedPluginSave Prepared)>();
            try
            {
                foreach (var (column, columnChanges) in byColumn)
                {
                    var realPlugin = columnChanges[0].Plugin;
                    writtenPlugins.Add(realPlugin);
                    prepared.Add((column, await session.PreparePluginSave(realPlugin, columnChanges)));
                }
            }
            catch
            {
                foreach (var (_, p) in prepared) p.Dispose();
                throw;
            }

            return prepared;
        });

        if (result is SaveGroupResult.Saved saved)
        {
            var plugins = writtenPlugins.ToArray();
            try
            {
                await session.ReindexPlugins(plugins);
            }
            catch (Exception ex)
            {
                // The file and pending-changes transaction already committed. A reindex throw must
                // not turn a completed save into a reported failure — fold it into a named failure
                // so the frontend can surface "saved, but the index is stale" (#127, ADR-0026).
                logger.LogError(ex, "Reindex failed after saving {Plugins}; index is stale", string.Join(", ", plugins));
                return saved with { ReindexFailure = new ReindexFailure(plugins, ex.Message) };
            }
        }

        return result;
    }
}
