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
            foreach (var plugin in changes.GetChanges(memberChangeId: memberChangeId)
                         .Select(c => c.Plugin)
                         .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var meta = s.Plugins.FirstOrDefault(p =>
                    p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
                if (meta?.IsImmutable == true)
                    return new SaveGroupResult.ImmutablePlugin(plugin);
            }
        }

        var result = await changes.ExecuteGroupSaveAsync(memberChangeId, async byPlugin =>
        {
            var prepared = new List<(string Plugin, PreparedPluginSave Prepared)>();
            try
            {
                foreach (var (plugin, pluginChanges) in byPlugin)
                    prepared.Add((plugin, await session.PreparePluginSave(plugin, pluginChanges)));
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
            var plugins = saved.ByPlugin.Keys.ToArray();
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
