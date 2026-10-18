using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>The Build gesture's handler (ADR-0014), the Build engine's way in. The mod is the item of the selection:
/// its folder is written from its source as the build configuration says, or it is refused.</summary>
public sealed class BuildModHandler
{
    private readonly SourceModBuild _build;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;
    private readonly INotificationPublisher _notifications;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal BuildModHandler(SourceModBuild build, LoadOrderHolder loadOrder, ISourceAdapter source, INotificationPublisher notifications) =>
        (_build, _loadOrder, _source, _notifications) = (build, loadOrder, source, notifications);

    /// <summary>Each mod's plugins are its source's, compiled into its folder against the held load order. Refuses the
    /// whole selection, writing nothing, when no load order is held or git cannot run.</summary>
    public async Task<SelectionResult<string, BuildRefusal, BuiltMod>> BuildAsync(IReadOnlyList<ModToBuild> mods, InstanceToBuild instance)
    {
        if (_loadOrder.Held is null)
            return SelectionResult<string, BuildRefusal, BuiltMod>.WholeSelectionRefused(BuildRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (_source.WhyGitCannotRun() is { } gitMissing)
            return SelectionResult<string, BuildRefusal, BuiltMod>.WholeSelectionRefused(BuildRefusal.GitUnavailable, gitMissing.Reason);

        return await ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new BuildProgressNotification(progress)),
            mod => _build.BuildAsync(mod, instance), gesture: null, CancellationToken.None);
    }
}
