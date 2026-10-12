using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>The Build gesture's handler (ADR-0014), the Build engine's way in. The mod is the item of the
/// selection: it lands with each plugin it provides compiled from its source, or refused on its own.</summary>
public sealed class BuildHandler
{
    private readonly CompilePluginHandler _compile;
    private readonly LoadOrderHolder _loadOrder;
    private readonly INotificationPublisher _notifications;
    private readonly ISourceAdapter _source;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal BuildHandler(
        CompilePluginHandler compile, LoadOrderHolder loadOrder, ISourceAdapter source, INotificationPublisher notifications) =>
        (_compile, _loadOrder, _source, _notifications) = (compile, loadOrder, source, notifications);

    /// <summary>Each name is a mod, whose plugins the held load order says. Refuses with
    /// <see cref="BuildRefusal.NoLoadOrder"/>, writing nothing, when none is held.</summary>
    public async Task<SelectionResult<string, BuildRefusal, BuiltMod>> BuildAsync(IReadOnlyList<string> mods)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return SelectionResult<string, BuildRefusal, BuiltMod>.WholeSelectionRefused(BuildRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var total = mods.Distinct(StringComparer.OrdinalIgnoreCase).Count();
        var done = 0;
        try
        {
            return await ItemWrite.OverAsync(_source, mods, StringComparer.OrdinalIgnoreCase, BuildRefusal.GitUnavailable, async mod =>
            {
                _notifications.Publish(new BuildProgressNotification(new BuildProgress(mod, done, total)));
                var built = await BuildModAsync(loadOrder, mod);
                done++;
                return built;
            });
        }
        finally
        {
            // Idle at rest, success or failure alike: a client must never keep showing a build that has finished.
            _notifications.Publish(new BuildProgressNotification(new BuildProgress(null, 0, 0)));
        }
    }

    private async Task<ItemAnswer<BuildRefusal, BuiltMod>> BuildModAsync(LoadOrderSnapshot loadOrder, string modName)
    {
        var plugins = loadOrder.Plugins
            .Where(plugin => plugin.Provider is PluginProvider.FromMod mod
                && string.Equals(mod.Name, modName, StringComparison.OrdinalIgnoreCase))
            .Select(plugin => plugin.Key)
            .ToList();
        var compiled = await _compile.CompileAsync(plugins);
        return ItemAnswer<BuildRefusal, BuiltMod>.Landed(new BuiltMod(compiled.Landed, compiled.Refused));
    }
}
