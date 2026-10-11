using Mutagen.Bethesda.Plugins.Exceptions;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.Codec.Serialization;

/// <summary>A refusal that names whatever the Mutagen exception reported, not its unlocated
/// <c>Message</c>. Mutagen enriches identity onto the exception nearest the parse and may rethrow
/// through parallel-parse <see cref="AggregateException"/>s, hence the tree walk.</summary>
public sealed record PluginDiagnosis(string? Anchor, string DefectClass, string? Tail, string Message)
{
    /// <summary>The class every diagnosis defaults to until a per-defect detector can name
    /// the actual defect from the plugin's own bytes.</summary>
    public const string UnknownClass = "unknown";

    // Kind A is ADR-0006's legitimate data, matched by message substring since Mutagen's
    // exceptions carry no error code.
    private static readonly (string MessageContains, string Tail)[] KindATable =
    [
        ("All FNAM strings should be the same", "blocked upstream: Mutagen #687"),
    ];

    /// <summary>Track's seam: the deepest <see cref="RecordException"/> in the tree anchors the diagnosis;
    /// otherwise the plugin itself is all that can honestly be named.</summary>
    public static PluginDiagnosis FromParseException(Exception ex)
    {
        var deepest = FindDeepest<RecordException>(ex);
        var message = deepest?.Message ?? ex.Message;
        return new PluginDiagnosis(DescribeRecord(deepest), UnknownClass, TailFor(message), message);
    }

    /// <summary>Compile's seam: reading source JSON never throws a RecordException, so the deepest
    /// <see cref="FilePathedException"/>'s path is the anchor. Every path is relative to
    /// <paramref name="readRoot"/>, the folder the door read.</summary>
    public static PluginDiagnosis FromSourceReadException(Exception ex, string readRoot)
    {
        var deepest = FindDeepest<FilePathedException>(ex);
        var message = (deepest?.InnerException?.Message ?? ex.Message).Replace(
            Path.TrimEndingDirectorySeparator(readRoot) + Path.DirectorySeparatorChar, "", StringComparison.Ordinal);
        var anchor = deepest == null ? null : Path.GetRelativePath(readRoot, deepest.Path);
        return new PluginDiagnosis(anchor, UnknownClass, TailFor(message), message);
    }

    // Every branch, not a linear InnerException walk: that only reaches InnerExceptions[0] and would miss
    // a second independently failed parallel-parse branch. Deepest wins, ties by list order.
    private static T? FindDeepest<T>(Exception ex) where T : Exception => FindDeepest<T>(ex, depth: 0).Found;

    private static (T? Found, int Depth) FindDeepest<T>(Exception ex, int depth) where T : Exception
    {
        var best = ex is T match ? (Found: match, Depth: depth) : (Found: null, Depth: -1);

        IEnumerable<Exception> children;
        if (ex is AggregateException aggregate) children = aggregate.InnerExceptions;
        else if (ex.InnerException is { } inner) children = [inner];
        else children = [];

        foreach (var child in children)
        {
            var candidate = FindDeepest<T>(child, depth + 1);
            if (candidate.Found != null && candidate.Depth > best.Depth)
                best = candidate;
        }

        return best;
    }

    private static string? TailFor(string message) =>
        KindATable.FirstOrDefault(e => message.Contains(e.MessageContains, StringComparison.Ordinal)).Tail;

    private static string? DescribeRecord(RecordException? re)
    {
        if (re == null || (re.FormKey == null && re.EditorID == null && re.RecordType == null))
            return null;
        return $"{re.RecordType?.Name ?? "record"}{(re.FormKey != null ? " " + re.FormKey : "")}{(re.EditorID != null ? $" ({re.EditorID})" : "")}";
    }

    /// <summary><c>&lt;anchor&gt; — &lt;label&gt;: &lt;message&gt;</c>, naming just "the plugin" when nothing
    /// more specific survived — never a guessed identity.</summary>
    public string Describe()
    {
        string label;
        if (DefectClass == UnknownClass) label = Tail ?? DefectClass;
        else if (Tail == null) label = DefectClass;
        else label = $"{DefectClass}, {Tail}";
        return $"{Anchor ?? "the plugin"} — {label}: {Message}";
    }
}
