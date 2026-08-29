using Mutagen.Bethesda.Plugins.Exceptions;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.Core.Source;

/// <summary>
/// #519's diagnosis floor: when Track or Compile refuses a plugin because Mutagen itself threw
/// (rather than the model-identity/subrecord-loss checks #513/#514 already wired), the refusal
/// names whatever the failing exception actually reported instead of surfacing that exception's own
/// unlocated <c>Message</c> — real defect classes (subrecord order, fixed-length/fixed-count,
/// counter/entries, PERK entry-point shape) are #569's table; this ticket only owns the uniform
/// shape and the <see cref="UnknownClass"/> fallback every one of them defaults to until #569 lands.
///
/// <para><b>Two call sites, two exception vocabularies — proven live, not assumed.</b> Track's
/// deep-parse (<c>ModFactory.ImportSetter</c>, a real binary parse) can throw Mutagen's own
/// <see cref="RecordException"/> (and its <c>SubrecordException</c> subtype), which carries
/// <c>FormKey</c>/<c>EditorID</c>/<c>RecordType</c> when the parser got far enough to attach them.
/// Compile's <c>DeserializeSource</c> reads a JSON source tree back into the object model — a
/// completely different Mutagen.Bethesda.Serialization code path that never touches binary parsing
/// and therefore never throws <see cref="RecordException"/> at all: a forged corrupt-FormKey-string
/// fixture confirmed it throws <see cref="FilePathedException"/> wrapping a plain
/// <see cref="ArgumentException"/> instead, whose only identity is the source file path. The two
/// factories below anchor to whichever vocabulary that seam's own exceptions actually offer, rather
/// than forcing one shape onto both.</para>
///
/// <para><b>Tree-walk, not a linear chain and not the caught exception's own properties.</b> Mutagen
/// enriches identity onto the exception nearest where a record was actually being parsed and
/// rethrows outward, sometimes through one or more <see cref="AggregateException"/>s from its own
/// parallel record-block parsing (<c>ListBinaryTranslation.ParseParallel</c>, a real
/// <c>Parallel.ForEach</c>) — proven live against <c>SouthOfTheSea.esm</c>'s real REFR
/// <c>XWPG</c>/<c>XWPN</c> defect: the exception <c>Fallout4Mod.CreateFromBinary</c> actually throws
/// is a bare <see cref="RecordException"/> with no identity at all (only <c>EnrichAndThrow(ex,
/// modKey)</c> ran on it), three levels above the <c>SubrecordException</c> that carries the real
/// <c>FormKey</c>/<c>EditorID</c>. Reading only the caught exception's own properties would silently
/// regress to plugin-level-only anchoring for exactly this parallel-parse case. A single-branch walk
/// of <see cref="Exception.InnerException"/> is not enough either: when concurrent iterations fail
/// simultaneously, <see cref="AggregateException"/> holds <i>every</i> one in
/// <see cref="AggregateException.InnerExceptions"/>, and <c>.InnerException</c> only ever forwards to
/// <c>InnerExceptions[0]</c> — realistic for any plugin with more than one corrupt record, and a
/// second corrupt record whose own exception happens to land elsewhere in that list would otherwise
/// never be visited at any depth. Both factories therefore recurse into every branch
/// (<see cref="FindDeepest{T}"/>) and keep the deepest match found anywhere in the tree, not merely
/// the first one a linear walk would have reached.</para>
/// </summary>
public sealed record PluginDiagnosis(string? Anchor, string DefectClass, string? Tail, string Message)
{
    /// <summary>The class every diagnosis defaults to until a per-defect detector (#569) can name
    /// the actual defect from the plugin's own bytes.</summary>
    public const string UnknownClass = "unknown";

    /// <summary>
    /// Kind A: legitimate plugin data Mutagen's own model cannot round-trip (ADR-0043) — never
    /// repaired, only named and refused pending an upstream fix. Matched by a substring of the
    /// innermost exception's own message, since Mutagen's exceptions carry no error code, only free
    /// text.
    ///
    /// <para>Only one entry has a real, reproducible fixture in hand: <c>Clipboards to the
    /// BOS.esp</c>'s <c>MaterialSwap</c> throws exactly this message when its <c>FNAM</c> strings
    /// disagree (found live against the LitR corpus while planning this ticket). Mutagen #688
    /// (FormLinks inside a <c>ScriptStructListProperty</c>, pruned on write — #520) is documented
    /// here, not wired, on purpose: no confirmed live fixture exists yet, and
    /// <c>docs/specs/medit-repair.md</c>'s own rule ("a row without a real fixture does not ship")
    /// applies just as much to this table as to the repair catalogue it was written for. Add its own
    /// entry the day one turns up.</para>
    /// </summary>
    private static readonly (string MessageContains, string Tail)[] KindATable =
    [
        ("All FNAM strings should be the same", "blocked upstream: Mutagen #687"),
    ];

    /// <summary>Track's own seam: the deepest <see cref="RecordException"/> anywhere in <paramref name="ex"/>'s
    /// own exception tree anchors the diagnosis when Mutagen's binary parser attached one; otherwise
    /// the plugin itself is all that can honestly be named — never a fabricated record identity.</summary>
    public static PluginDiagnosis FromParseException(Exception ex)
    {
        var deepest = FindDeepest<RecordException>(ex);
        var message = deepest?.Message ?? ex.Message;
        return new PluginDiagnosis(DescribeRecord(deepest), UnknownClass, TailFor(message), message);
    }

    /// <summary>Compile's own seam: reading a source file back into the object model is a JSON
    /// operation with no <see cref="RecordException"/> in reach at all — the source file itself
    /// (the same identity unit <c>PluginCompileService.RefuseIfSourceDoesNotRoundTrip</c> already
    /// names as "the offender") is the anchor, taken from the deepest
    /// <see cref="FilePathedException"/> anywhere in <paramref name="ex"/>'s own exception tree.
    /// <paramref name="treeRoot"/> is the <c>source/&lt;plugin&gt;/</c> directory itself, so the
    /// anchor reads as a path within it (e.g. <c>Npcs/[0] FixtureNpc - 000802_Fixture.esp.json</c>) —
    /// the file's own name already carries EditorID and FormKey by <c>SourceUnitResolver</c>'s own
    /// naming convention.</summary>
    public static PluginDiagnosis FromSourceReadException(Exception ex, string treeRoot)
    {
        var deepest = FindDeepest<FilePathedException>(ex);
        var message = deepest?.InnerException?.Message ?? ex.Message;
        var anchor = deepest == null ? null : Path.GetRelativePath(treeRoot, deepest.Path);
        return new PluginDiagnosis(anchor, UnknownClass, TailFor(message), message);
    }

    /// <summary>
    /// The deepest exception of type <typeparamref name="T"/> anywhere in <paramref name="ex"/>'s own
    /// exception tree — not a linear <see cref="Exception.InnerException"/> walk, which only ever
    /// reaches <see cref="AggregateException.InnerExceptions"/>'s first element and would silently
    /// miss a second, independently-failed branch (see this class's own doc comment). "Deepest" mirrors
    /// what a linear walk that kept overwriting its result on every step would have found along a
    /// single path — the record identity Mutagen enriches nearest the actual parse failure — extended
    /// to pick the deepest match across every branch when more than one exists, breaking ties by
    /// <see cref="AggregateException.InnerExceptions"/>'s own order (first found at the winning depth).
    /// </summary>
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

    /// <summary>The refusal-text fragment every caller shares: <c>&lt;anchor&gt; — &lt;class&gt;:
    /// &lt;message&gt;</c>, naming just "the plugin" when nothing more specific survived the failure —
    /// never a guessed identity.</summary>
    public string Describe() => $"{Anchor ?? "the plugin"} — {Tail ?? DefectClass}: {Message}";
}
