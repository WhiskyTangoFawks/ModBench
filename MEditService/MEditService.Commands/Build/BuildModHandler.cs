using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>The Build gesture's handler (ADR-0014), the Build engine's way in. The mod is the item of the selection:
/// one built-in step of its build runs, or it is refused.</summary>
public sealed class BuildModHandler
{
    private readonly SourceModBuild _build;
    private readonly CompilePluginHandler _compile;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;
    private readonly INotificationPublisher _notifications;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal BuildModHandler(
        SourceModBuild build, CompilePluginHandler compile, LoadOrderHolder loadOrder, ISourceAdapter source, INotificationPublisher notifications) =>
        (_build, _compile, _loadOrder, _source, _notifications) = (build, compile, loadOrder, source, notifications);

    /// <summary>Each mod's step runs against the held load order. Refuses the whole selection, writing nothing, when no load
    /// order is held or git cannot run. <paramref name="cancel"/> stops the wait, not the writes.</summary>
    public async Task<Answer<BuildResult, SelectionRefusal<BuildRefusal>>> BuildAsync(
        IReadOnlyList<ModToBuild> mods, InstanceToBuild instance, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is null)
            return new SelectionRefusal<BuildRefusal>(BuildRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (_source.WhyGitCannotRun() is { } gitMissing)
            return new SelectionRefusal<BuildRefusal>(BuildRefusal.GitUnavailable, gitMissing.Reason);

        var built = await ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new BuildProgressNotification(progress)),
            (mod, _) => _build.BuildAsync(mod, instance), CancellationToken.None);
        await _compile.ReadBack(built.Landed.SelectMany(mod => mod.Outcome.Compiled), cancel);
        return built.ToResult(
            landed => ModBuiltOf(landed.Item, landed.Outcome),
            refused => new BuildRefused(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new BuildResult(applied, refused));
    }

    private static ModBuilt ModBuiltOf(string mod, ModBuildOutcome built) => new(
        mod,
        [.. built.Compiled.Select(compiled => new CompiledPlugin(compiled.Item.Name, compiled.Item.Origin, compiled.Outcome))],
        [.. built.Refused.Select(refused => new CompileRefused(refused.Item, refused.Refusal, refused.Message))],
        [.. built.ArchivesRefused.Select(refused => new ArchiveRefused(refused.Item, refused.Refusal, refused.Message))],
        built.Failure, built.Uncommitted, built.Unpushed, built.Made, built.Packed, built.Replaced, built.Ignored);
}
