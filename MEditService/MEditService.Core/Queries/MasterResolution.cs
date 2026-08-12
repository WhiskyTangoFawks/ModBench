using System.Text.Json.Serialization;
using MEditService.Core.Session;

namespace MEditService.Core.Queries;

// #277 / ADR-0037: a plugin with an unresolvable master is indexed and flagged, never deactivated.
// Distinguishes a directly-missing master (never attempted at all — absent from both the loaded
// set and the failed set) from a master that is itself unloadable (attempted, recorded in
// GameSession.LoadFailures) so a cascade of failures doesn't read as one undifferentiated error.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum MasterIssueKind
{
    DirectlyMissing,
    Unloadable,
}

public sealed record MasterIssue(string MasterName, MasterIssueKind Kind);

// Pure — no session, no Mutagen re-read: `GameSession.Plugins` and `GameSession.LoadFailures`
// already carry everything this needs. Deliberately shallow: only a plugin's OWN declared
// `Masters` list is consulted, never a master's own masters — a cascade is exactly what
// ADR-0037 rules out (xEdit's fixpoint loop exists only because deactivation cascades; nothing
// here deactivates, so there is nothing to propagate).
public static class MasterResolution
{
    /// <summary>Per-plugin master issues, keyed by plugin name; a plugin with every master
    /// resolved has no entry (never an empty list).</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<MasterIssue>> Classify(
        IReadOnlyList<PluginMetadata> plugins, IReadOnlyList<PluginLoadFailure> failures)
    {
        var loaded = plugins.Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var failed = failures.Select(f => f.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var result = new Dictionary<string, IReadOnlyList<MasterIssue>>(StringComparer.OrdinalIgnoreCase);
        foreach (var plugin in plugins)
        {
            var issues = new List<MasterIssue>();
            foreach (var master in plugin.Masters)
            {
                if (loaded.Contains(master)) continue;
                var kind = failed.Contains(master) ? MasterIssueKind.Unloadable : MasterIssueKind.DirectlyMissing;
                issues.Add(new MasterIssue(master, kind));
            }
            if (issues.Count > 0) result[plugin.Name] = issues;
        }
        return result;
    }
}
