using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Build;

/// <summary>The decompile and commit gesture's handler (ADR-0007, ADR-0014). The mod is the item of the selection:
/// it lands whole with one commit, `Init &lt;mod&gt;`, or refuses whole.</summary>
public sealed class DecompileAndCommitModHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly INotificationPublisher _notifications;
    private readonly ISourceAdapter _source;
    private readonly ModInit _init;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal DecompileAndCommitModHandler(
        LoadOrderHolder loadOrder, IPluginAdapter adapter, ISourceAdapter source, IModFolderRepository modFolders,
        INotificationPublisher notifications, ILogger<DecompileAndCommitModHandler> logger) =>
        (_loadOrder, _source, _notifications, _init) =
            (loadOrder, source, notifications, new ModInit(logger, source, modFolders, new PluginDecompiler(logger, adapter, source)));

    /// <summary>Each mod's plugins and folder are the held load order's. Refuses with
    /// <see cref="DecompileAndCommitRefusal.NoLoadOrder"/>, writing nothing, when none is held; git missing refuses
    /// the whole selection once.</summary>
    public async Task<Answer<DecompileAndCommitResult, SelectionRefusal<DecompileAndCommitRefusal>>> DecompileAndCommitAsync(
        IReadOnlyList<ModToDecompileAndCommit> mods, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return new SelectionRefusal<DecompileAndCommitRefusal>(DecompileAndCommitRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (_source.WhyGitCannotRun() is { } gitMissing)
            return new SelectionRefusal<DecompileAndCommitRefusal>(DecompileAndCommitRefusal.GitUnavailable, gitMissing.Reason);
        var decompiled = await ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new DecompileAndCommitProgressNotification(progress, Phase: null)),
            (mod, at) => _init.InitAsync(
                loadOrder, mod, new HashSet<PluginAddress>(), repair: null,
                phase => _notifications.Publish(new DecompileAndCommitProgressNotification(at, phase)), cancel),
            cancel);
        return decompiled.ToResult(
            landed => new DecompiledAndCommittedMod(landed.Item, landed.Outcome),
            refused => new DecompileAndCommitRefused(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new DecompileAndCommitResult(applied, refused));
    }
}
