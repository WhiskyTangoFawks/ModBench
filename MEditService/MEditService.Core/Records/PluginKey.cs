namespace MEditService.Core.Records;

/// <summary>
/// Compound plugin identity (ADR-0036): a physical plugin file is identified by its filename
/// together with the mod folder that provided it (<see cref="Origin"/>), never filename alone —
/// two loaded copies can share a filename. The seam-wide replacement for every historical
/// <c>(string plugin, string origin)</c> parameter pair, including ingest (<c>Index</c>).
/// </summary>
/// <param name="Name">The plugin's bare filename (e.g. <c>Skyrim.esm</c>).</param>
/// <param name="Origin">
/// The mod folder that provided the physical file, or a reserved <see cref="Plugins.PluginOrigin"/>
/// value. <b>Null-Origin semantics at this seam today:</b> the pinned contract's intent is that a
/// null <see cref="Origin"/> resolves server-side among load-order members (ADR-0036/#306) — but
/// <see cref="IRecordIndex"/>/<see cref="IRecordReads"/> do not perform that resolution themselves
/// (#421 deliberately does not build it; the call site above the seam does, via
/// <c>Plugins.PluginOriginResolver</c>, exactly as it did before this reshape). Concretely:
/// <list type="bullet">
/// <item>On an <b>identity-bearing</b> member (one that names a single indexed plugin row —
/// <c>GetDocument(formKey, PluginKey)</c>, <c>Index</c>, <c>Unindex</c>,
/// <c>SetPluginParticipation</c>, <c>GetNativeFormKeys</c>, <c>GetEffectiveMasters</c>, the spatial
/// reads, <c>GetRecordTypeCounts</c>), <see cref="Origin"/> was already a required, non-nullable
/// string on every one of these before the reshape. A null <see cref="Origin"/> here is not
/// resolved — the underlying <c>origin</c> column is <c>NOT NULL</c>, so the call <b>silently
/// matches no row</b> rather than picking one. Callers must resolve before constructing the key,
/// same as before.</item>
/// <item>On a <b>filter</b> position (<see cref="RecordQuery.Plugin"/>, the only place a
/// <see cref="PluginKey"/> narrows rather than names), a null <see cref="Origin"/> preserves the
/// pre-reshape filter behaviour: "this plugin name, any origin" — no narrowing, not "matches
/// nothing".</item>
/// </list>
/// In-seam resolution among load-order members remains an open contract item, carried forward to
/// #415.
/// </param>
public readonly record struct PluginKey(string Name, string? Origin = null)
{
    public static implicit operator PluginKey(string name) => new(name);
}
