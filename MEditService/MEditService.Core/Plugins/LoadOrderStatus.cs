namespace MEditService.Core.Plugins;

/// <summary>
/// Where the load order mirror is right now (ADR-0035, ADR-0044). Reconciling is a state a
/// caller can observe and act on, not an internal phase — a plugin's records are browsable the
/// moment it is indexed, well before the reconcile finishes.
/// </summary>
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
}

/// <summary>One plugin copy the mirror has finished indexing or registering. Carries origin as well
/// as filename because a copy is identified by <c>(origin, plugin)</c> together —
/// two copies of one filename can be held at once, and a bare name cannot say which one landed.</summary>
public sealed record IndexedPlugin(string Name, string Origin);

/// <summary>
/// What the mirror can honestly say about itself right now (ADR-0035). Exists so that an
/// absent conflict badge is never mistakable for "no conflict": a caller reading
/// <see cref="ConflictsComputed"/> false knows nothing has looked yet.
/// </summary>
/// <param name="TotalPlugins">How many plugin copies the last snapshot resolved to — the
/// denominator for progress. Copies that fail to open still count toward it.</param>
/// <param name="IndexedPlugins">Those whose indexing has completed, in the order they landed. A
/// plugin appears here only once it is wholly queryable.</param>
/// <param name="ConflictsComputed">Whether the winner sweep has run since the last change to the
/// registered set. Distinct from <see cref="State"/> being <see cref="LoadOrderState.Ready"/>,
/// though the two coincide today: the sweep is whole-set, so every reconcile that changes anything
/// leaves winners stale until it is re-run. A caller deciding whether to render conflict
/// information must read this one, not the state.</param>
/// <param name="Failures">Plugin copies that could not be opened or indexed, as they are discovered
/// — not held back until the reconcile finishes (ADR-0026).</param>
public sealed record LoadOrderStatus(
    LoadOrderState State,
    int TotalPlugins,
    IReadOnlyList<IndexedPlugin> IndexedPlugins,
    bool ConflictsComputed,
    IReadOnlyList<PluginLoadFailure> Failures)
{
    public static readonly LoadOrderStatus None =
        new(LoadOrderState.None, 0, [], ConflictsComputed: false, []);
}
