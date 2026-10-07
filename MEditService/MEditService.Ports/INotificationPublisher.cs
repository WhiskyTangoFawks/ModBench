using MEditService.LoadOrder;

namespace MEditService.Ports;

/// <summary>ADR-0014's publish port.</summary>
public interface INotificationPublisher
{
    void Publish(INotification notification);
}

/// <summary>One of the notification kinds the Ports box names (target-architecture.d2
/// medit_kernel.ports).</summary>
public interface INotification;

/// <summary>A projection landed: Keys changed in Plugin, and Sequence is the Index's projection
/// sequence right after — a subscriber re-reads once its own read catches up to it.</summary>
public sealed record RowsChangedNotification(PluginAddress Plugin, IReadOnlyList<string> Keys, long Sequence)
    : INotification;

/// <summary>A validation re-derived or removed a whole plugin (ADR-0003) — too many
/// rows to name, so this names the plugin instead.</summary>
public sealed record PluginChangedNotification(PluginAddress Plugin, long Sequence)
    : INotification;

/// <summary>The Index's <see cref="LoadOrderStatus"/> whenever it changes — reconciling through to
/// Ready, the same transitions <c>GET /load-order/status</c> polling would have observed.</summary>
public sealed record LoadOrderStatusNotification(LoadOrderStatus Status) : INotification;

/// <summary>Track's own progress (<see cref="TrackProgress"/>) as it advances through parsing,
/// serializing and committing.</summary>
public sealed record TrackProgressNotification(TrackProgress Progress) : INotification;

/// <summary>At a snapshot: each tracked plugin whose bytes differ from what Modbench last wrote
/// (ADR-0003). The mod's whole answer, so a plugin it leaves out matches; a mod whose
/// repository went names none.</summary>
public sealed record ExternalChangeNotification(string Origin, IReadOnlyList<ChangedPlugin> Plugins)
    : INotification;

/// <summary>BytesSha256 names the state of the plugin's bytes, and is null when they cannot be
/// read.</summary>
public sealed record ChangedPlugin(string Name, string? BytesSha256);

/// <summary>The plugins of a tracked mod whose plugin source is unreadable.</summary>
public sealed record PluginSourceUnreadableNotification(string Origin, IReadOnlyList<string> Plugins)
    : INotification;

/// <summary>The record filter could not apply again after a change to the index, so the Index
/// cleared it. Source names the filter's source; Reason is the database's.</summary>
public sealed record RecordFilterClearedNotification(string Source, string Reason) : INotification;
