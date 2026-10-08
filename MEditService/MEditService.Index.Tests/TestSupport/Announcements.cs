using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>What an arrival announces, as a test waits for it (ADR-0015).</summary>
internal static class Announcements
{
    internal static Predicate<INotification> PluginChanged(LoadOrderEntry plugin) =>
        n => n is PluginChangedNotification changed && PluginAddress.Comparer.Equals(changed.Plugin, plugin.KeyOf());

    internal static Predicate<INotification> RowsChanged(string formKey) =>
        n => n is RowsChangedNotification rows && rows.Keys.Contains(formKey);

    internal static Predicate<INotification> FailureNamed(string plugin) =>
        n => n is LoadOrderStatusNotification status && status.Status.Failures.Any(f => f.Name == plugin);

    /// <summary>Two equal arrivals, each answered once the change it found is announced. An arrival
    /// validates every plugin before it announces, so a plugin neither announced is known quiet.</summary>
    internal static IReadOnlyList<INotification> AnnouncedByEqualArrivals(
        this OpenedIndex index, InMemoryNotificationPublisher notifications, Func<Predicate<INotification>> change)
    {
        var start = notifications.Notifications.Count;
        for (var arrival = 0; arrival < 2; arrival++)
        {
            var announced = change();
            var before = notifications.Notifications.Count;
            index.NextSnapshotUntil(() => notifications.Since(before).Any(n => announced(n)), "the change the arrival found");
        }
        return notifications.Since(start);
    }

    /// <summary>An untracked plugin's binary rewritten: announced as the plugin.</summary>
    internal static Predicate<INotification> Touched(LoadOrderEntry plugin)
    {
        PluginBinaries.Touch(plugin.Path);
        return PluginChanged(plugin);
    }

    /// <summary>A tracked plugin's one NPC renamed on disk under a new name: announced as its rows.</summary>
    internal static Predicate<INotification> RenamedByHand(this LoadOrderEntry plugin, OpenedIndex index)
    {
        var listed = index.Records.GetRecords(["npc_"], plugin.KeyOf(), search: null, limit: 1, offset: 0).Items.Single();
        var document = index.DocumentOf(listed.FormKey, plugin.KeyOf());
        plugin.HandEdit(document, $"\"{document.EditorId}\"", $"\"Edited{Guid.NewGuid():N}\"");
        return RowsChanged(listed.FormKey);
    }

    internal static IReadOnlyList<INotification> Since(this InMemoryNotificationPublisher notifications, int count) =>
        [.. notifications.Notifications.Skip(count)];
}
