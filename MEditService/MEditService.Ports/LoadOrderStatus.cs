using System.Text.Json.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Ports;

/// <summary>Where the Index's reconcile is right now (ADR-0013). Reconciling is
/// observable rather than an internal phase: a plugin's records are browsable the moment it is
/// indexed, well before the reconcile finishes.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LoadOrderState
{
    /// <summary>No load order has been received yet, or it was closed.</summary>
    None,

    /// <summary>A snapshot is being reconciled: plugins are still being opened and indexed.
    /// Everything already indexed is queryable and correct *for that plugin*; anything comparing
    /// plugins is not yet settled.</summary>
    Reconciling,

    /// <summary>Every plugin has been indexed and the winner sweep has run.</summary>
    Ready,

    /// <summary>ADR-0009 point 5: another Modbench window holds this instance's index file.
    /// <see cref="LoadOrderStatus.Message"/> names it; nothing here is held.</summary>
    HeldElsewhere,

    /// <summary>The reconcile threw something neither known refusal names.
    /// <see cref="LoadOrderStatus.Message"/> names it (ADR-0019: failures are data, never only
    /// a log line).</summary>
    Failed,
}

/// <summary>Carries origin as well as filename because two copies of one filename can be held at
/// once, and a bare name cannot say which one landed.</summary>
public sealed record IndexedPlugin(string Name, string Origin);

/// <summary>Exists so an absent conflict badge is never mistakable for "no conflict": a caller
/// reading <see cref="ConflictsComputed"/> false knows nothing has looked yet, which is a different
/// question from the state being Ready (ADR-0013).</summary>
public sealed record LoadOrderStatus(
    LoadOrderState State,
    int TotalPlugins,
    IReadOnlyList<IndexedPlugin> IndexedPlugins,
    bool ConflictsComputed,
    IReadOnlyList<PluginLoadFailure> Failures,
    // Non-null only for HeldElsewhere or Failed: the ready-to-show reason, carried here because
    // neither ever reaches the put's own response.
    string? Message = null,
    // The Apply this status answers for — a client waits for this to reach its own Apply's
    // version, never for a tick a fast or no-op reconcile can settle before one is subscribed.
    long Version = 0)
{
    public static readonly LoadOrderStatus None =
        new(LoadOrderState.None, 0, [], ConflictsComputed: false, []);
}
