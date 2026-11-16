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

/// <summary>The record index moved and no more is named: a subscriber re-reads everything it shows. Sequence is
/// the Index's projection sequence right after.</summary>
public sealed record RecordIndexChangedNotification(long Sequence) : INotification;

/// <summary>The Index's <see cref="LoadOrderStatus"/> whenever it changes — reconciling through to
/// Ready, the same transitions <c>GET /load-order/status</c> polling would have observed.</summary>
public sealed record LoadOrderStatusNotification(LoadOrderStatus Status) : INotification;

/// <summary>Why a compiled plugin's source does not read, and whether decompile gets past it.</summary>
public sealed record UnreadableSource(string Reason, bool DecompileRepairs);

/// <summary>Why the record filter was cleared, kept until the next one is set or cleared: it could not apply
/// again. Reason is the database's; Sequence is the Index's projection sequence right after.</summary>
public sealed record FilterCleared(string Source, string Reason, long Sequence);
