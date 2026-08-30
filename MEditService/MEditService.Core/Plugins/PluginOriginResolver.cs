namespace MEditService.Core.Plugins;

// #271 / ADR-0036: resolves the real origin the load order already knows for a plugin filename
// (populated by LoadOrder/LoadOrderMirror since #269), so a read driven only by a
// bare filename still binds to the compound (origin, plugin) identity rather than the reserved
// default. Falls back to PluginOrigin.DataDirectory when no load order or no matching plugin is
// found — every plugin filename currently maps to exactly one origin, so a name absent from
// Load order.Plugins can't yet mean "a second origin for a filename already loaded elsewhere."
//
// #34: a load order can now hold two copies of one filename, so the candidate set is narrowed to the
// load order's own members before matching. That restores the property this resolver depends on —
// a filename names at most one plugin *within the load order*, because plugins.txt cannot list a
// name twice — and it is what makes it correct for write targets to travel as bare filenames.
// Membership, not participation: a disabled plugins.txt line is still in the load order and is
// still a legitimate write target (#270 / ADR-0035).
//
// Scoping rather than ordering is deliberate. Unlisted copies are appended after the load order is
// built, so a plain first-match happens to return the right plugin today — but that is an accident
// of list order, and this method's callers (RecordEditService, RecordQueryService,
// WorldspaceQueryService) are scoping their reads with it.
public static class PluginOriginResolver
{
    public static string Resolve(ILoadOrder? loadOrder, string plugin) =>
        loadOrder.LoadOrderPlugin(plugin)?.Origin ?? PluginOrigin.DataDirectory;

    // #306: the same scoping Resolve depends on, exposed directly for callers that need the full
    // plugin metadata rather than just the origin string. Resolve, in this file, is currently the
    // only production caller. Null means "no load-order member of this name" — callers must treat
    // that as a refusal. Written as an extension rather than an ILoadOrder member so it doesn't
    // force a mechanical edit onto every hand-written ILoadOrder test double.
    //
    // Write gestures are gated elsewhere and not by this method: RecordEditService.RefuseIfBlocked,
    // via ModFolders.TrackedOf/ModFolders.Of, keyed on PluginKey.Origin (specifically, whether it
    // equals PluginOrigin.DataDirectory).
    public static PluginMetadata? LoadOrderPlugin(this ILoadOrder? loadOrder, string plugin) =>
        loadOrder?.Plugins.FirstOrDefault(p =>
            p.InLoadOrder && p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
}
