namespace MEditService.Core.Session;

// Participates (#267 / ADR-0035): the plugins.txt `*` prefix — whether this plugin loads in the
// game and competes for winner. An indexed-but-non-participating row can never be a winner and
// never contributes to conflict classification; see DuckDbRecordIndex.UpdateWinners and
// ConflictClassifier.Classify. Implicit masters and freshly created plugins always participate.
//
// Origin (#269 / ADR-0036): the mod folder that provided this physical file, or one of the
// reserved values in PluginOrigin — opaque here, never interpreted. As of #271, SessionManager
// threads this into DuckDbRecordIndex.Index, so record tables key on (form_key, origin,
// plugin) — this is no longer inert. Required (#275): every construction site must say which
// origin this is, not fall back to one silently.
public record PluginMetadata(
    string Name,
    string Path,
    int LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable,
    string Origin,
    bool Participates = true,
    // InLoadOrder (#34 / ADR-0035): whether the effective load order names this plugin at all.
    // False only for a file loaded on demand that the load order does not point at — a copy
    // shadowed by a higher-priority mod, or a file plugins.txt never lists. Distinct from
    // Participates, which is the `*` prefix of a plugins.txt line that *is* in the load order: a
    // disabled plugin doesn't participate but is still a legitimate write target, while this one
    // is read-only and is not in Mutagen's LoadOrder or LinkCache at all.
    bool InLoadOrder = true
);

/// <summary>A plugin that could not be loaded into the session (e.g. an unparseable record);
/// it is skipped so the rest of the load order still loads, and reported here.</summary>
public record PluginLoadFailure(string Name, string Reason)
{
    /// <summary>#395: the reason a failure reports is never just the outer exception's message —
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
