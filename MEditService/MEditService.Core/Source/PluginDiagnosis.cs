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
/// <para><b>Chain-walk, not the caught exception's own properties.</b> Mutagen enriches identity
/// onto the exception nearest where a record was actually being parsed and rethrows outward,
/// sometimes through one or more <see cref="AggregateException"/>s from its own parallel
/// record-block parsing — proven live against <c>SouthOfTheSea.esm</c>'s real REFR
/// <c>XWPG</c>/<c>XWPN</c> defect: the exception <c>Fallout4Mod.CreateFromBinary</c> actually throws
/// is a bare <see cref="RecordException"/> with no identity at all (only <c>EnrichAndThrow(ex,
/// modKey)</c> ran on it), three levels above the <c>SubrecordException</c> that carries the real
/// <c>FormKey</c>/<c>EditorID</c>. Reading only the caught exception's own properties would silently
/// regress to plugin-level-only anchoring for exactly this parallel-parse case, so both factories
/// walk the full <see cref="Exception.InnerException"/> chain for the innermost occurrence.</para>
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

    /// <summary>Track's own seam: the innermost <see cref="RecordException"/> in <paramref name="ex"/>'s
    /// chain anchors the diagnosis when Mutagen's binary parser attached one; otherwise the plugin
    /// itself is all that can honestly be named — never a fabricated record identity.</summary>
    public static PluginDiagnosis FromParseException(Exception ex)
    {
        RecordException? deepest = null;
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is RecordException re) deepest = re;
        }

        var message = deepest?.Message ?? ex.Message;
        return new PluginDiagnosis(DescribeRecord(deepest), UnknownClass, TailFor(message), message);
    }

    /// <summary>Compile's own seam: reading a source file back into the object model is a JSON
    /// operation with no <see cref="RecordException"/> in reach at all — the source file itself
    /// (the same identity unit <c>PluginCompileService.RefuseIfSourceDoesNotRoundTrip</c> already
    /// names as "the offender") is the anchor, taken from the innermost
    /// <see cref="FilePathedException"/> in <paramref name="ex"/>'s chain. <paramref name="treeRoot"/>
    /// is the <c>source/&lt;plugin&gt;/</c> directory itself, so the anchor reads as a path within it
    /// (e.g. <c>Npcs/[0] FixtureNpc - 000802_Fixture.esp.json</c>) — the file's own name already
    /// carries EditorID and FormKey by <c>SourceUnitResolver</c>'s own naming convention.</summary>
    public static PluginDiagnosis FromSourceReadException(Exception ex, string treeRoot)
    {
        FilePathedException? deepest = null;
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is FilePathedException fpe) deepest = fpe;
        }

        var message = deepest?.InnerException?.Message ?? ex.Message;
        var anchor = deepest == null ? null : Path.GetRelativePath(treeRoot, deepest.Path);
        return new PluginDiagnosis(anchor, UnknownClass, TailFor(message), message);
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
