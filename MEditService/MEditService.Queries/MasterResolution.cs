using System.Text.Json.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Queries;

// ADR-0012: a plugin with an unresolvable master is indexed and flagged, never deactivated. A
// directly-missing master (never attempted) is told apart from one that is itself unloadable
// so a cascade doesn't read as one undifferentiated error.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum MasterIssueKind
{
    DirectlyMissing,
    Unloadable,
}

public sealed record MasterIssue(string MasterName, MasterIssueKind Kind);

// Pure and deliberately shallow: only a plugin's own declared Masters are consulted, never a
// master's masters — a cascade is exactly what ADR-0012 rules out; nothing here deactivates,
// so there is nothing to propagate.
internal static class MasterResolution
{
    /// <summary>Per-copy master issues; a copy with every master resolved has no entry (never an
    /// empty list). A master is named by filename, so any copy of that name resolves it.</summary>
    public static IReadOnlyDictionary<PluginAddress, IReadOnlyList<MasterIssue>> Classify(
        IReadOnlyDictionary<PluginAddress, PluginContent> opened, IReadOnlyList<PluginLoadFailure> failures)
    {
        var loaded = opened.Keys.Select(k => k.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var failed = failures.Select(f => f.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var result = new Dictionary<PluginAddress, IReadOnlyList<MasterIssue>>(PluginAddress.Comparer);
        foreach (var (key, content) in opened)
        {
            var issues = new List<MasterIssue>();
            foreach (var master in content.Masters)
            {
                if (loaded.Contains(master)) continue;
                var kind = failed.Contains(master) ? MasterIssueKind.Unloadable : MasterIssueKind.DirectlyMissing;
                issues.Add(new MasterIssue(master, kind));
            }
            if (issues.Count > 0) result[key] = issues;
        }
        return result;
    }
}
