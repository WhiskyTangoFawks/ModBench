namespace MEditService.Core.Session;

// #271 / ADR-0036: resolves the real origin the session already knows for a plugin filename
// (populated by GameSession/SessionManager since #269), so a read or staged edit driven only by a
// bare filename still binds to the compound (origin, plugin) identity rather than the reserved
// default. Falls back to PluginOrigin.DataDirectory when no session or no matching plugin is
// found — every plugin filename currently maps to exactly one origin, so a name absent from
// Session.Plugins can't yet mean "a second origin for a filename already staged elsewhere."
//
// #34: a session can now hold two copies of one filename, so the candidate set is narrowed to the
// load order's own members before matching. That restores the property this resolver depends on —
// a filename names at most one plugin *within the load order*, because plugins.txt cannot list a
// name twice — and it is what makes it correct for write targets to travel as bare filenames.
// Membership, not participation: a disabled plugins.txt line is still in the load order and is
// still a legitimate write target (#270 / ADR-0035).
//
// Scoping rather than ordering is deliberate. Unlisted copies are appended after the load order is
// built, so a plain first-match happens to return the right plugin today — but that is an accident
// of list order, and this method's callers (EditOrchestrator, RecordQueryService,
// WorldspaceQueryService) are attributing pending changes with it.
public static class PluginOriginResolver
{
    public static string Resolve(IGameSession? session, string plugin) =>
        session?.Plugins
            .FirstOrDefault(p => p.InLoadOrder && p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase))?.Origin
        ?? PluginOrigin.DataDirectory;
}
