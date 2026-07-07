using MEditService.Core.Session;

namespace MEditService.Core.Edits;

public abstract record SaveGroupResult
{
    public sealed record NoChanges : SaveGroupResult;
    public sealed record Saved(IReadOnlyDictionary<string, SaveResult> ByPlugin) : SaveGroupResult;
    public sealed record ImmutablePlugin(string Plugin) : SaveGroupResult;
}

public sealed class PluginSaver(IPendingChangeService changes, ISessionManager session)
{
    public async Task<SaveGroupResult> Save(Guid groupId)
    {
        var s = session.Session;
        if (s != null)
        {
            foreach (var plugin in changes.GetChanges(groupId: groupId)
                         .Select(c => c.Plugin)
                         .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var meta = s.Plugins.FirstOrDefault(p =>
                    p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
                if (meta?.IsImmutable == true)
                    return new SaveGroupResult.ImmutablePlugin(plugin);
            }
        }

        var result = await changes.ExecuteGroupSaveAsync(groupId, async byPlugin =>
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
            await session.ReindexPlugins([.. saved.ByPlugin.Keys]);

        return result;
    }
}
