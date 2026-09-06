using MEditService.Core.Records;

namespace MEditService.Core.Notifications;

/// <summary>ADR-0046 invariant 12: the notification channel's one publish surface. Who is
/// listening — the SSE stream, a test recorder, nobody — is the adapter's business alone.</summary>
public interface INotificationPublisher
{
    void Publish(Notification notification);
}

/// <summary>One of the notification kinds ADR-0046 names. Kind is both the SSE event name and the
/// wire discriminator.</summary>
public abstract record Notification(string Kind)
{
    /// <summary>The one wire shape every kind serializes to.</summary>
    public abstract NotificationEvent ToEvent();
}

/// <summary>A projection landed: Keys changed in Plugin, and Sequence is the Index's projection
/// sequence right after — a subscriber re-reads once its own read catches up to it.</summary>
public sealed record RowsChangedNotification(PluginKey Plugin, IReadOnlyList<string> Keys, long Sequence)
    : Notification("rows-changed")
{
    public override NotificationEvent ToEvent() => new(Kind, Plugin.Name, Plugin.Origin ?? "", Keys, Sequence);
}

/// <summary>The plugin watcher re-indexed or removed a whole binary (ADR-0001) — too many rows to
/// name, so this names the plugin instead.</summary>
public sealed record PluginChangedNotification(PluginKey Plugin, long Sequence)
    : Notification("plugin-changed")
{
    // Empty Keys: whole plugin, not named rows.
    public override NotificationEvent ToEvent() => new(Kind, Plugin.Name, Plugin.Origin ?? "", [], Sequence);
}

/// <summary>The one wire shape for every notification kind, declared on the OpenAPI surface so the
/// generated client carries these fields even though the stream is consumed with a raw fetch.</summary>
public sealed record NotificationEvent(string Kind, string Plugin, string Origin, IReadOnlyList<string> Keys, long Sequence);
