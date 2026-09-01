using Mutagen.Bethesda.Plugins.Exceptions;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.Core.Source;

/// <summary>
/// The diagnosis floor: when Track or Compile refuses a plugin because Mutagen itself threw
/// (rather than the model-identity/subrecord-loss checks), the refusal
/// names whatever the failing exception actually reported instead of surfacing that exception's own
/// unlocated <c>Message</c> — per-defect detectors (subrecord order, fixed-length/fixed-count,
/// counter/entries, PERK entry-point shape) are future work; this owns only the uniform
/// shape and the <see cref="UnknownClass"/> fallback every one of them defaults to.
///
/// <para><b>Three call sites, three exception vocabularies — proven live, not assumed.</b> Track's
/// deep-parse (<c>ModFactory.ImportSetter</c>, a real binary parse) can throw Mutagen's own
/// <see cref="RecordException"/> (and its <c>SubrecordException</c> subtype), which carries
/// <c>FormKey</c>/<c>EditorID</c>/<c>RecordType</c> when the parser got far enough to attach them.
/// Compile's <c>DeserializeSource</c> reads a JSON source tree back into the object model — a
/// completely different Mutagen.Bethesda.Serialization code path that never touches binary parsing
/// and therefore never throws <see cref="RecordException"/> at all: a forged corrupt-FormKey-string
/// fixture confirmed it throws <see cref="FilePathedException"/> wrapping a plain
/// <see cref="ArgumentException"/> instead, whose only identity is the source file path. The binary
/// *write* both Track's round-trip gate and Compile's own save run through
/// (<c>PluginWriter</c>'s <c>MastersListContentOption.Iterate</c>, ADR-0038) throws a third
/// shape: Mutagen's own <c>WriteMajorRecord</c> enriches a <see cref="RecordException"/> exactly as
/// the deep-parse path does, but wraps <see cref="UnmappableFormIDException"/> instead of a
/// <c>SubrecordException</c> — confirmed live against the real <c>SpaDia_AMR.esp</c> fixture (Quest
/// <c>DiaQ_LLInjector_SpadeyAMR</c>, whose VMAD struct-list script property references
/// <c>DLCNukaWorld.esm</c> in a way Mutagen's own <c>ScriptStructListProperty.EnumerateFormLinks</c>
/// never walks — Mutagen-Modding/Mutagen upstream issue 688 — so the content-derived master pass prunes a master
/// the write still needs). The three factories below anchor to whichever vocabulary that seam's own
/// exceptions actually offer, rather than forcing one shape onto all.</para>
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
    /// <summary>The class every diagnosis defaults to until a per-defect detector can name
    /// the actual defect from the plugin's own bytes.</summary>
    public const string UnknownClass = "unknown";

    /// <summary>
    /// Kind A: legitimate plugin data Mutagen's own model cannot round-trip (ADR-0043) — never
    /// repaired, only named and refused pending an upstream fix. Matched by a substring of the
    /// innermost exception's own message, since Mutagen's exceptions carry no error code, only free
    /// text.
    ///
    /// <para><c>Clipboards to the BOS.esp</c>'s <c>MaterialSwap</c> throws exactly the first message
    /// below when its <c>FNAM</c> strings disagree (found live against the LitR
    /// corpus); that message is unique to this one defect, so its tail is unhedged. The
    /// second entry is different in kind: Mutagen's own "Could not map FormKey to a master
    /// index" is <see cref="UnmappableFormIDException"/>'s generic message for *any* unresolvable
    /// master, not only the struct-list-property gap upstream issue 688 names — every occurrence seen so far
    /// (<c>SpaDia_AMR.esp</c>'s <c>DiaQ_LLInjector_SpadeyAMR</c>, checked in as
    /// <c>TestData</c>) is that gap, but the message alone cannot prove it is *this* occurrence's
    /// cause, so the tail says "likely" rather than asserting it.</para>
    /// </summary>
    private static readonly (string MessageContains, string Tail)[] KindATable =
    [
        ("All FNAM strings should be the same", "blocked upstream: Mutagen #687"),
        ("Could not map FormKey to a master index",
            "likely blocked upstream: Mutagen #688 (FormLinks inside a VMAD struct-list script " +
            "property are the known cause of this shape, not confirmed for every instance)"),
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

    /// <summary>The write seam both Track's round-trip gate and Compile's own save share:
    /// anchors on the deepest <see cref="RecordException"/> exactly as <see cref="FromParseException"/>
    /// does (Mutagen's <c>WriteMajorRecord</c> enriches one the same way its binary parser does), and
    /// separately walks for the deepest <see cref="UnmappableFormIDException"/> — a different type,
    /// nested one level inside that <see cref="RecordException"/> — to name the master the write
    /// could not map. Naming the master is the reason this needs its own factory rather than reusing
    /// <see cref="FromParseException"/> as-is: <see cref="RecordException.Message"/> here is only ever
    /// Mutagen's generic "Could not map FormKey to a master index", which never says which master, so
    /// the message this composes states only what the exception genuinely proves — the record and the
    /// pruned master — and leaves any causal claim to the hedged upstream-issue tail above, never
    /// asserted here.</summary>
    public static PluginDiagnosis FromWriteException(Exception ex)
    {
        var deepestRecord = FindDeepest<RecordException>(ex);
        var rawMessage = deepestRecord?.Message ?? ex.Message;
        var master = FindDeepest<UnmappableFormIDException>(ex)?.UnmappableFormKey.FormKey.ModKey.FileName;
        var message = master != null
            ? $"references {master}, which this write's content-derived master list pruned before resolving it"
            : rawMessage;
        return new PluginDiagnosis(DescribeRecord(deepestRecord), UnknownClass, TailFor(rawMessage), message);
    }

    /// <summary>The narrow catch-filter test for the one Kind A write shape: is
    /// <see cref="UnmappableFormIDException"/> anywhere in <paramref name="ex"/>'s own exception
    /// tree. A caller uses this to decide whether to divert to <see cref="FromWriteException"/> at
    /// all — every other write failure must propagate untouched, never
    /// falling back to a silent <c>NoCheck</c> and never widening to a second Kind
    /// A row.</summary>
    public static bool HasUnmappableFormID(Exception ex) => FindDeepest<UnmappableFormIDException>(ex) != null;

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

    /// <summary>The refusal-text fragment every caller shares: <c>&lt;anchor&gt; — &lt;label&gt;:
    /// &lt;message&gt;</c>, naming just "the plugin" when nothing more specific survived the failure —
    /// never a guessed identity. A classed (Kind B, #569) diagnosis carries both its class and its
    /// repair tail in the label; an <see cref="UnknownClass"/> one shows its tail alone (Kind A's
    /// "blocked upstream"), or the class when there is no tail either.</summary>
    public string Describe()
    {
        string label;
        if (DefectClass == UnknownClass) label = Tail ?? DefectClass;
        else if (Tail == null) label = DefectClass;
        else label = $"{DefectClass}, {Tail}";
        return $"{Anchor ?? "the plugin"} — {label}: {Message}";
    }
}
