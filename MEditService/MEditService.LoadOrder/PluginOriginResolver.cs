namespace MEditService.LoadOrder;

// ADR-0012: resolves the origin the load order knows for a filename, so a read driven by a bare
// filename still binds to the compound (origin, plugin) identity rather than the reserved default,
// which is the fallback when nothing matches.

// Candidates are narrowed to load-order members because plugins.txt cannot list a name twice, which
// is what makes a bare filename a safe write target. Membership, not participation: a disabled line
// is still a legitimate write target (ADR-0013).

// Scoping, not ordering: unlisted copies are appended after the load order is built, so a plain
// first-match returns the right plugin today only by accident of list order.
public static class PluginOriginResolver
{
    public static string Resolve(LoadOrderSnapshot loadOrder, string plugin) =>
        loadOrder.Copies
            .FirstOrDefault(c =>
                c.Registration.InLoadOrder && c.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase))
            ?.Origin
        ?? PluginOrigin.DataDirectory;
}
