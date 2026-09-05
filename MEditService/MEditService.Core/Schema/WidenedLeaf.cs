using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>The applier for a member whose type differs across a union's leaves: the real type is
/// resolved off the receiver, so one writer serves every variant.</summary>
internal static class WidenedLeaf
{
    /// <summary>Applies a union member onto an already-resolved concrete leaf.
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

    // No guessing: the property's declared type is known by now. The document carries a raw JSON
    // number or bool; text is accepted too.
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
