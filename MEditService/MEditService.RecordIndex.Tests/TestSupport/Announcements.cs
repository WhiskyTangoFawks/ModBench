using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>What a check of the disk announces, as a test waits for it (ADR-0015).</summary>
internal static class Announcements
{
    internal static Predicate<INotification> PluginChanged(LoadOrderEntry plugin) =>
        n => n is PluginChangedNotification changed && PluginAddress.Comparer.Equals(changed.Plugin, plugin.Key);

    internal static Predicate<INotification> RowsChanged(string formKey) =>
        n => n is RowsChangedNotification rows && rows.Keys.Contains(formKey);

    internal static Predicate<INotification> FailureNamed(string plugin) =>
        n => n is LoadOrderStatusNotification status && status.Status.Failures.Any(f => f.Name == plugin);

    /// <summary>Two checks of the disk, each answered once the change it found is announced. A check
    /// validates every plugin before it announces, so a plugin neither announced is known quiet.</summary>
    internal static IReadOnlyList<INotification> AnnouncedByChecks(
        this OpenedIndex index, InMemoryNotificationPublisher notifications, Func<Predicate<INotification>> change)
    {
        var start = notifications.Notifications.Count;
        for (var check = 0; check < 2; check++)
        {
            var announced = change();
            var before = notifications.Notifications.Count;
            index.NextCheckUntil(() => notifications.Since(before).Any(n => announced(n)), "the change the check found");
        }
        return notifications.Since(start).WithoutValidations();
    }

    /// <summary>A non-compiled plugin's binary rewritten: announced as the plugin.</summary>
    internal static Predicate<INotification> Touched(LoadOrderEntry plugin)
    {
        PluginBinaries.Touch(plugin.Path);
        return PluginChanged(plugin);
    }

    /// <summary>A compiled plugin's one NPC renamed on disk under a new name: announced as its rows.</summary>
    internal static Predicate<INotification> RenamedByHand(this LoadOrderEntry plugin, OpenedIndex index)
    {
        var listed = index.Queries.GetRecords(["npc_"], plugin.Key, search: null, limit: 1, offset: 0).Value().Items.Single();
        var document = index.DocumentOf(listed.FormKey, plugin.Key);
        plugin.RenameByHand(document, $"Edited{Guid.NewGuid():N}");
        return RowsChanged(listed.FormKey);
    }

    internal static IReadOnlyList<INotification> Since(this InMemoryNotificationPublisher notifications, int count) =>
        [.. notifications.Notifications.Skip(count)];

    /// <summary>Without each validation's statuses: the validating ones, and the one that closes them.</summary>
    internal static IReadOnlyList<INotification> WithoutValidations(this IEnumerable<INotification> notifications)
    {
        List<INotification> kept = [];
        var validating = false;
        foreach (var notification in notifications)
        {
            if (notification is LoadOrderStatusNotification status && (status.Status.Validating || validating))
            {
                validating = status.Status.Validating;
                continue;
            }
            kept.Add(notification);
        }
        return kept;
    }
}
