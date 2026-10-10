using MEditService.LoadOrder;

namespace MEditService.Ports;

/// <summary>ADR-0014's publish port.</summary>
public interface INotificationPublisher
{
    void Publish(INotification notification);
}

/// <summary>One notification mEdit sends its clients (target-architecture.d2
/// medit_kernel.ports).</summary>
public interface INotification;

/// <summary>A projection landed: Keys changed in Plugin, and Sequence is the Index's projection
/// sequence right after — a subscriber re-reads once its own read catches up to it.</summary>
public sealed record RowsChangedNotification(PluginAddress Plugin, IReadOnlyList<string> Keys, long Sequence)
    : INotification;

/// <summary>A validation changed a plugin as a whole (ADR-0003): re-derived or removed it, or its read
/// failed or recovered while its rows stood. It names the plugin, not rows.</summary>
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

/// <summary>The plugins of a tracked mod whose plugin source is unreadable, each with why and whether decompile
/// gets past it.</summary>
public sealed record PluginSourceUnreadableNotification(string Origin, IReadOnlyList<PluginWithUnreadableSource> Plugins)
    : INotification;

public sealed record PluginWithUnreadableSource(string Name, UnreadableSource Source);

/// <summary>Why a tracked plugin's source does not read, and whether decompile gets past it.</summary>
public sealed record UnreadableSource(string Reason, bool DecompileRepairs);

/// <summary>The record filter could not apply again after a change to the index, so the Index
/// cleared it. Source names the filter's source; Reason is the database's.</summary>
public sealed record RecordFilterClearedNotification(string Source, string Reason) : INotification;
