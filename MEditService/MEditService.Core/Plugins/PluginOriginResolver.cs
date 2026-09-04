namespace MEditService.Core.Plugins;

// ADR-0036: resolves the origin the load order knows for a filename, so a read driven by a bare
// filename still binds to the compound (origin, plugin) identity rather than the reserved default,
// which is the fallback when nothing matches.

// Candidates are narrowed to load-order members because plugins.txt cannot list a name twice, which
// is what makes a bare filename a safe write target. Membership, not participation: a disabled line
// is still a legitimate write target (ADR-0035).

// Scoping, not ordering: unlisted copies are appended after the load order is built, so a plain
// first-match returns the right plugin today only by accident of list order.
public static class PluginOriginResolver
{
    public static string Resolve(ILoadOrder? loadOrder, string plugin) =>
        loadOrder.LoadOrderPlugin(plugin)?.Origin ?? PluginOrigin.DataDirectory;

    // Null means "no load-order member of this name", which callers must treat as a refusal. An
    // extension rather than an ILoadOrder member so it forces no mechanical edit onto every
    // hand-written ILoadOrder test double.
    public static PluginMetadata? LoadOrderPlugin(this ILoadOrder? loadOrder, string plugin) =>
        loadOrder?.Plugins.FirstOrDefault(p =>
            p.InLoadOrder && p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
}
