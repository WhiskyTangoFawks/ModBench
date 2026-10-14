using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>After each snapshot, pushes each mod whose status changed since the last push (mod-status trace). A check
/// runs off the snapshot's request, and the snapshots that arrive while one runs are checked once, as the latest.</summary>
internal sealed class ModStatusCheck(IModFolderRepository repository, INotificationPublisher notifications)
{
    private readonly Lock _gate = new();
    private SnapshotMods? _waiting;
    private bool _checking;
    private Dictionary<string, ModStatus> _pushed = new(StringComparer.Ordinal);

    public void Check(SnapshotMods snapshot)
    {
        lock (_gate)
        {
            _waiting = snapshot;
            if (_checking) return;
            _checking = true;
        }
        _ = Task.Run(CheckUntilNoneWaits);
    }

    private void CheckUntilNoneWaits()
    {
        while (Next() is { } snapshot) Push(snapshot);
    }

    private SnapshotMods? Next()
    {
        lock (_gate)
        {
            var next = _waiting;
            _waiting = null;
            _checking = next is not null;
            return next;
        }
    }

    private void Push(SnapshotMods snapshot)
    {
        Dictionary<string, ModStatus> now = new(StringComparer.Ordinal);
        foreach (var mod in snapshot.Mods)
            now[mod.Name] = repository.Status(mod.Folder, mod.Name, mod.CommittedFiles.ToHashSet(StringComparer.Ordinal), snapshot.StatCache);
        List<string> changed = [.. now.Where(status => !_pushed.TryGetValue(status.Key, out var was) || !was.Equals(status.Value)).Select(status => status.Key)];
        _pushed = now;
        if (changed.Count > 0) notifications.Publish(new ModStatusChangedNotification(changed));
    }
}
