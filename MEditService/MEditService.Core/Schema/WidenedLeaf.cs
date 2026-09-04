using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A leaf whose siblings disagree about its CLR type, presented as text, with an applier
/// that resolves the real type off the receiver. No JSON path has consistent semantics, so it stays
/// out of the generated views.</summary>
internal static class WidenedLeaf
{
    // CoerceToColumnType's VARCHAR branch is a culture-bound ToString, so a widened number must be
    // formatted with InvariantCulture here or "3,5" leaks through under de-DE. bool keeps the
    // JS-idiomatic lowercase spelling.
    internal static object? FormatWidenedValue(object? value) => value switch
    {
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => value,
    };

    /// <summary>Applies a widened OMOD leaf-union field onto an already-resolved concrete leaf.
    /// <see cref="ApplyOutcome.PropertyNotFound"/> and a JSON null are expected no-ops; a value the
    /// declared type cannot take is rejected, never silently dropped.</summary>
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

    // The inverse of FormatWidenedValue, with no guessing: the property's declared type is known by
    // now. A freshly added element may send a raw JSON number or bool instead of text; both are accepted.
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
