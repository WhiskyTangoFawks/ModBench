using MEditService.Core.Records;

namespace MEditService.Core.Plugins;

// One physical plugin copy the load order holds (ADR-0044): what the file says about itself
// (masters, flags, record count) beside the three facts Mod Management states about it —
// LoadOrderIndex, Enabled, Winning — which are exactly its Registration row. Participation and
// load-order membership are derived from those three, never stored, so a reconcile that moves a
// flag cannot leave a cached verdict behind.
//
// Origin (ADR-0036): the mod folder that provided this physical file, or one of the
// reserved values in PluginOrigin — opaque here, never interpreted. Record tables key on
// (form_key, origin, plugin). Required: every construction site must say which origin this
// is, not fall back to one silently.
//
// LoadOrderIndex: the name's plugins.txt slot offset past the game's forced masters, or null when
// no line names the file. A losing copy of a listed name carries the same slot as the winning one.
//
// IsForced: a vanilla master or Creation Club plugin the game loads regardless of plugins.txt —
// always resolved from the game directory, always participating, never editable.
public record PluginMetadata(
    string Name,
    string Path,
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsForced,
    string Origin,
    bool Enabled,
    bool Winning)
{
    public PluginKey Key => new(Name, Origin);

    /// <summary>The registration row this copy holds — what <c>IRecordIndex.Register</c> writes.</summary>
    public Registration Registration => new(LoadOrderIndex, Enabled, Winning);

    /// <summary>See <see cref="Registration.Participates"/>: whether this copy competes for winner
    /// and counts in a conflict.</summary>
    public bool Participates => Registration.Participates;

    /// <summary>See <see cref="Registration.InLoadOrder"/>: whether plugins.txt names this copy —
    /// the winning copy of a listed name, enabled or not. What makes a bare filename a safe write
    /// target: plugins.txt cannot list a name twice, so at most one held copy per name is in the
    /// load order.</summary>
    public bool InLoadOrder => Registration.InLoadOrder;

    /// <summary>Read-only for editing: a forced master (ADR-0036: the game's own files are never a
    /// write target), or a copy the load order does not name — editing a file the game does not
    /// load changes nothing anywhere.</summary>
    public bool IsImmutable => IsForced || !InLoadOrder;
}

/// <summary>A plugin copy that could not be opened or indexed (e.g. an unparseable record); it is
/// a row in an error state (ADR-0044) — the rest of the load order is unaffected, and the reason
/// is reported here rather than surfacing as a failed reconcile.</summary>
public record PluginLoadFailure(string Name, string Reason)
{
    /// <summary>The reason a failure reports is never just the outer exception's message —
    /// Mutagen typically wraps a parse error (which record, which subrecord, offset) naming the
    /// actual cause several levels down the <see cref="Exception.InnerException"/> chain, and a
    /// bare <c>ex.Message</c> discards exactly that detail. This flattens the whole chain,
    /// outermost first, one line per level, each prefixed with its exception type name — every
    /// call site that builds a <see cref="PluginLoadFailure"/> from a caught exception goes
    /// through here rather than reading <c>ex.Message</c> directly.</summary>
    public static string ReasonFor(Exception ex)
    {
        var lines = new List<string>();
        for (Exception? current = ex; current is not null; current = current.InnerException)
            lines.Add($"{current.GetType().Name}: {current.Message}");
        return string.Join('\n', lines);
    }
}
