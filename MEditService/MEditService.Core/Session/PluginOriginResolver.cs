namespace MEditService.Core.Session;

// #271 / ADR-0036: resolves the real origin the session already knows for a plugin filename
// (populated by GameSession/SessionManager since #269), so a read or staged edit driven only by a
// bare filename still binds to the compound (origin, plugin) identity rather than the reserved
// default. Falls back to PluginOrigin.DataDirectory when no session or no matching plugin is
// found — every plugin filename currently maps to exactly one origin, so a name absent from
// Session.Plugins can't yet mean "a second origin for a filename already staged elsewhere."
//
// #34 forward note: once a session can hold two same-filename plugins simultaneously,
// FirstOrDefault(p => p.Name == plugin) can resolve to a shadowed copy's origin instead of the
// loaded one, and this lookup must become load-order-aware. This is the single home for that
// lookup precisely so #34 only has to fix it once — every caller listed below (EditOrchestrator,
// RecordQueryService, WorldspaceQueryService) goes through this one method, so the fix lands for
// all of them at once instead of needing a separate patch per caller that happened to inline its
// own copy.
public static class PluginOriginResolver
{
    public static string Resolve(IGameSession? session, string plugin) =>
        session?.Plugins
            .FirstOrDefault(p => p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase))?.Origin
        ?? PluginOrigin.DataDirectory;
}
