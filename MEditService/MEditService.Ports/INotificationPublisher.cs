using MEditService.LoadOrder;

namespace MEditService.Ports;

/// <summary>ADR-0014 invariant 2: the notification channel's one publish surface. Who is
/// listening — the SSE stream, a test recorder, nobody — is the adapter's business alone.</summary>
public interface INotificationPublisher
{
    void Publish(Notification notification);
}

/// <summary>One of the notification kinds ADR-0014 names. Kind is both the SSE event name and the
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

/// <summary>The plugin watcher re-indexed or removed a whole binary (ADR-0009) — too many rows to
/// name, so this names the plugin instead.</summary>
public sealed record PluginChangedNotification(PluginKey Plugin, long Sequence)
    : Notification("plugin-changed")
{
    // Empty Keys: whole plugin, not named rows.
    public override NotificationEvent ToEvent() => new(Kind, Plugin.Name, Plugin.Origin ?? "", [], Sequence);
}

/// <summary>The Index's <see cref="LoadOrderStatus"/> whenever it changes — reconciling through to
/// Ready, the same transitions <c>GET /load-order/status</c> polling would have observed.</summary>
public sealed record LoadOrderStatusNotification(LoadOrderStatus Status) : Notification("load-order-status")
{
    public override NotificationEvent ToEvent() => new(Kind, "", "", [], 0, LoadOrderStatus: Status);
}

/// <summary>Track's own progress (<see cref="TrackProgress"/>) as it advances through parsing,
/// serializing and committing.</summary>
public sealed record TrackProgressNotification(TrackProgress Progress) : Notification("track-progress")
{
    public override NotificationEvent ToEvent() => new(Kind, "", Progress.Origin ?? "", [], 0, TrackProgress: Progress);
}

/// <summary>A question is open for this mod: a genuine external change awaiting Absorb/Keep, or,
/// when <paramref name="CrashRepairReason"/> is set, a repair offer instead. The mod folder is
/// never on the wire — Origin names it.</summary>
public sealed record QuestionOpenNotification(
    string Origin, IReadOnlyList<string> Plugins, IReadOnlyList<string> TrackedFiles,
    bool MetaChanged, string? OldVersion, string? NewVersion, string? CrashRepairReason = null)
    : Notification("question-open")
{
    // Keys carries Plugins: the generic string list every other kind already has, repurposed rather
    // than adding a field only this kind would fill.
    public override NotificationEvent ToEvent() => new(Kind, "", Origin, Plugins, 0,
        ExternalChangeMetaChanged: MetaChanged, ExternalChangeOldVersion: OldVersion, ExternalChangeNewVersion: NewVersion,
        ExternalChangeTrackedFiles: TrackedFiles, CrashRepairReason: CrashRepairReason);
}

/// <summary>The one wire shape every notification kind serializes to. Kind is the discriminator; the
/// trailing groups are null except for the one kind that fills them.</summary>
public sealed record NotificationEvent(
    string Kind, string Plugin, string Origin, IReadOnlyList<string> Keys, long Sequence,
    LoadOrderStatus? LoadOrderStatus = null,
    TrackProgress? TrackProgress = null,
    bool? ExternalChangeMetaChanged = null,
    string? ExternalChangeOldVersion = null,
    string? ExternalChangeNewVersion = null,
    IReadOnlyList<string>? ExternalChangeTrackedFiles = null,
    string? CrashRepairReason = null);
