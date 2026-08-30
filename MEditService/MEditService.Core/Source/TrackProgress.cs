namespace MEditService.Core.Source;

/// <summary>The phases <see cref="TrackService.TrackAsync"/> moves through, in order — enough to
/// narrate a mega-plugin's worst-case tens-of-seconds Track (AC4, #414 review F2) without a
/// literal percentage: <c>Idle</c> (nothing in flight), <c>Parsing</c> (deep-parsing each plugin —
/// <see cref="TrackProgress.PluginsTotal"/> is the plugin count, known up front), <c>Serializing</c>
/// (each plugin's whole tree through the whole-mod door, <see cref="TrackProgress.PluginsDone"/>
/// advancing one <i>plugin</i> at a time — #451 slice A: granularity coarsened from per-record to
/// per-plugin, since the whole-mod door serializes each plugin as one call with no per-record
/// progress callback of its own to observe), <c>Committing</c> (the git mechanics — not itself broken
/// into finer steps).</summary>
public enum TrackPhase
{
    Idle,
    Parsing,
    Serializing,
    Committing,
}

/// <summary>What <see cref="TrackService"/> can say about a Track in flight right now — the read
/// behind <c>GET /plugins/track/status</c>, polled alongside the still in-flight
/// <c>POST /plugins/track</c>, the same idiom <c>LoadOrderStatus</c>/<c>GET /load-order/status</c>
/// already established for the reconcile. One shared instance on the singleton service, not
/// per-origin: Track is a single, deliberate user gesture — nothing today runs two at once, and
/// the AC only asks that a mega-plugin's own long Track narrates itself.
///
/// <para><see cref="PluginsDone"/>/<see cref="PluginsTotal"/> count <b>plugins</b>, not records, since
/// #451 slice A (see <see cref="TrackPhase"/>'s own doc comment) — renamed from the pre-#451
/// <c>RecordsDone</c>/<c>RecordsTotal</c> (#451 review: that first version claimed "nothing outside
/// this class reads them today," which was false — <c>modbench/src/medit/trackProgress.ts</c> renders
/// them into the Plugins view's own progress text, and a grep confined to <c>MEditService/</c> never
/// crossed the extension/backend boundary to find it). The rename, not a doc-comment fix alone, is
/// deliberate: it forces every consumer on both sides of the wire to be touched once, honestly, rather
/// than leaving a field named for records that has held plugin counts since #451.</para>
/// </summary>
public sealed record TrackProgress(string? Origin, TrackPhase Phase, int PluginsDone, int PluginsTotal)
{
    public static readonly TrackProgress Idle = new(null, TrackPhase.Idle, 0, 0);
}
