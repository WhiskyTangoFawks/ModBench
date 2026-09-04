using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A leaf whose concrete siblings disagree about its CLR type, so it is presented as text:
/// one rendering for reads, and one applier that resolves the target property's real type off the
/// receiver before converting. No single JSON path has consistent semantics for one of these, which
/// is why a widened column stays out of the generated views.</summary>
internal static class WidenedLeaf
{
    // A widened scalar column hands CoerceToColumnType a raw boxed *numeric* value, and that path's
    // VARCHAR branch is a bare value.ToString() with no culture — so on any non-en-US host a widened
    // float/int would round-trip through the current culture's separators (e.g. "3,5" under de-DE)
    // instead of the actual value. Format explicitly with InvariantCulture here, for every
    // IFormattable scalar, the same way every other numeric formatting in the reflected schema does
    // (see e.g. LeafClassification.GetEnumMembers' bit values). bool doesn't implement IFormattable
    // and keeps its own case: lowercase "true"/"false" (JS-idiomatic) rather than C#'s
    // "True"/"False". Anything neither (e.g. an already-string value) passes through unchanged.
    internal static object? FormatWidenedValue(object? value) => value switch
    {
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => value,
    };

    /// <summary>
    /// Applies one of the widened OMOD leaf union fields (<c>value</c>, <c>value2</c>,
    /// <c>function_type</c>) onto whichever concrete leaf <c>ListLeaves.ApplyListJson</c> already resolved.
    ///
    /// <para><see cref="ApplyOutcome.PropertyNotFound"/> when the target object's runtime type
    /// doesn't declare the property at all — an expected, silent outcome one layer up in
    /// <c>SubFieldValues.ApplySubFields</c> (same convention as <c>LeafWriters.MakeApplier</c>): a leaf that lacks this member
    /// is exactly what this shape is for. A JSON <c>null</c> is likewise Applied-as-a-no-op — it
    /// means "this leaf's own Extract had nothing to read back for this member", not a value to
    /// reject.</para>
    ///
    /// <para><see cref="ApplyOutcome.ValueRejected"/> — never a silent no-op — when the
    /// property *does* exist but the incoming JSON can't be converted into whatever type it actually
    /// is: <c>SubFieldValues.ApplySubFields</c> folds that into a refusal of the whole element/struct write
    /// rather than constructing the right concrete type and then silently dropping a value onto
    /// it.</para>
    /// </summary>
    internal static Func<object, JsonElement, ApplyOutcome> MakeWidenedApplier(string pName, ILogger logger)
    {
        var resolve = LeafWriters.ResolveProperty(pName);
        return (obj, val) =>
        {
            var rp = resolve(obj.GetType());
            if (rp == null) return ApplyOutcome.PropertyNotFound;
            if (val.ValueKind == JsonValueKind.Null) return ApplyOutcome.Applied;
            var converted = ConvertWidenedJson(val, rp.PropertyType, pName, logger);
            if (converted == null) return ApplyOutcome.ValueRejected;
            rp.SetValue(obj, converted);
            return ApplyOutcome.Applied;
        };
    }

    // The inverse of FormatWidenedValue: a bool leaf's own text is "true"/"false" (that method's
    // own lowercase, JS-idiomatic spelling), an enum leaf's is one of its member names, and every
    // other leaf's is an InvariantCulture-formatted number — so parsing back is exactly as
    // straightforward as formatting was, no heuristics needed, because the property's actual
    // declared type is already known by the time this runs (unlike the read side, nothing
    // here is guessing which leaf it might be — ListLeaves.ApplyListJson resolved that before constructing the
    // object this is now applying onto). A freshly-added element with no prior GET to round-trip
    // may instead send a raw JSON number/bool rather than pre-formatted text; both are accepted.
    private static object? ConvertWidenedJson(JsonElement val, Type targetType, string pName, ILogger logger)
    {
        if (targetType == typeof(bool))
        {
            return val.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.String when bool.TryParse(val.GetString(), out var b) => b,
                _ => null,
            };
        }
        if (targetType.IsEnum)
        {
            var s = val.ValueKind == JsonValueKind.String ? val.GetString() : null;
            return s != null && Enum.TryParse(targetType, s, ignoreCase: true, out var e) ? e : null;
        }
        if (targetType == typeof(string))
            return val.ValueKind == JsonValueKind.String ? val.GetString() : val.GetRawText();

        var text = val.ValueKind == JsonValueKind.String ? val.GetString() : val.GetRawText();
        if (text == null) return null;
        try
        {
            return Convert.ChangeType(text, targetType, System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception ex) when (ex is FormatException or OverflowException or InvalidCastException)
        {
            // Same convention as LeafWriters.ApplyFormLinkJson's own best-effort catch: a malformed value is a
            // silent no-op to the write path, not a thrown exception, but not silent to the log either.
            if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
            return null;
        }
    }
}
