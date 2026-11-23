using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Build;

/// <summary>The version in git gesture's handler (ADR-0007, ADR-0014). The mod is the item of the selection:
/// it lands whole, or refuses whole.</summary>
public sealed class VersionInGitHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly INotificationPublisher _notifications;
    private readonly ISourceAdapter _source;
    private readonly HeldWrites _held;
    private readonly ModInit _init;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal VersionInGitHandler(
        LoadOrderHolder loadOrder, IPluginAdapter adapter, ISourceAdapter source, IModFolderRepository modFolders,
        INotificationPublisher notifications, SchemaReflector schemaReflector, HeldWrites held, ILogger<VersionInGitHandler> logger) =>
        (_loadOrder, _source, _notifications, _held, _init) =
            (loadOrder, source, notifications, held, new ModInit(logger, source, modFolders, new PluginDecompiler(logger, adapter, schemaReflector)));

    /// <summary>Each mod's plugins and folder are the held load order's. Refuses, writing nothing, when none is held or
    /// git cannot run.</summary>
    public async Task<Answer<VersionInGitResult, SelectionRefusal<VersionInGitRefusal>>> VersionInGitAsync(
        IReadOnlyList<ModToVersionInGit> mods, CancellationToken cancel = default)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return new SelectionRefusal<VersionInGitRefusal>(VersionInGitRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (_source.WhyGitCannotRun() is { } gitMissing)
            return new SelectionRefusal<VersionInGitRefusal>(VersionInGitRefusal.GitUnavailable, gitMissing.Reason);
        var (decompiled, written) = await WrittenFiles.Of(() => ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new VersionInGitProgressNotification(progress, Phase: null)),
            (mod, at) => _init.InitAsync(
                loadOrder, mod, new HashSet<PluginAddress>(), repair: null,
                phase => _notifications.Publish(new VersionInGitProgressNotification(at, phase)), CancellationToken.None),
            CancellationToken.None));
        await _held.ReadBackSource(decompiled.Landed.SelectMany(landed => landed.Outcome), cancel);
        return decompiled.ToResult(
            landed => new VersionedMod(landed.Item, landed.Outcome),
            refused => new VersionInGitRefused(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new VersionInGitResult(applied, refused, written));
    }
}
