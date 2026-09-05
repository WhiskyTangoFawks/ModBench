using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>How a leaf's value gets onto an object: property resolution off the receiver's runtime
/// type, and the appliers each leaf kind needs. Every leaf write goes through <see cref="SetOrDecline"/>.</summary>
internal static class LeafWriters
{
    // The target type varies per call (a sub-field's object can be any of several concrete types) while
    // the property name is fixed per closure, so the cache is keyed on the former.
    internal static Func<Type, PropertyInfo?> ResolveProperty(string pName)
    {
        var cache = new ConcurrentDictionary<Type, PropertyInfo?>();
        return t => cache.GetOrAdd(t, tt => tt.GetProperty(pName, BindingFlags.Public | BindingFlags.Instance));
    }

    /// <summary>Resolution is off the receiver's runtime type, so this is an open-world call: a same-named
    /// property of another shape declines the value instead of throwing out of the write path.</summary>
    internal static ApplyOutcome SetOrDecline(
        PropertyInfo rp, object obj, object? value, string pName, ILogger logger)
    {
        try
        {
            rp.SetValue(obj, value);
            return ApplyOutcome.Applied;
        }
        catch (ArgumentException ex)
        {
            if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
            return ApplyOutcome.ValueRejected;
        }
    }

    // Answers ApplyOutcome rather than void so a caller can tell a real refusal from the sub-field
    // layer's expected PropertyNotFound no-op; a void return would swallow every way this can fail.
    internal static Func<object, JsonElement, ApplyOutcome> MakeApplier(
        string pName, bool nullable, Func<JsonElement, object?> conv, ILogger logger)
    {
        var resolve = ResolveProperty(pName);
        return (obj, val) =>
        {
            var rp = resolve(obj.GetType());
            if (rp == null) return ApplyOutcome.PropertyNotFound;
            if (val.ValueKind == JsonValueKind.Null)
                return nullable ? SetOrDecline(rp, obj, null, pName, logger) : ApplyOutcome.ValueRejected;

            object? v;
            try
            {
                v = conv(val);
            }
            // No converter returns null on bad input; each throws (see IsDecliningConverterException),
            // so this catch turns a declining converter into ValueRejected.
            catch (Exception ex) when (IsDecliningConverterException(ex))
            {
                if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
                return ApplyOutcome.ValueRejected;
            }

            if (v == null) return ApplyOutcome.ValueRejected;
            return SetOrDecline(rp, obj, v, pName, logger);
        };
    }

    /// <summary>Where a classified leaf becomes a write or a named refusal. Generic in the receiver
    /// because the writer resolves its property off the target's runtime type; contravariance makes
    /// one body for record and sub-field.</summary>
    internal static LeafWrite<TTarget> RouteWriter<TTarget>(
        LeafSpec leaf, PropertyInfo prop, Type core, bool nullable, GameReflection game, ILogger logger)
        where TTarget : class
    {
        var pName = prop.Name;
        Func<object, JsonElement, ApplyOutcome>? writer = leaf.Convert switch
        {
            // The document spells a translated string as an object; its Value is what the converter takes.
            { } c when ReflectedTypes.IsTranslatedString(core) => MakeApplier(pName, nullable, v => c(TranslatedStringValue(v)), logger),
            { } c => MakeApplier(pName, nullable, c, logger),
            null when ReflectedTypes.IsFormLink(core) => (obj, val) => ApplyFormLinkJson(obj, val, pName, logger),
            null when ByteSliceHex.IsByteSlice(core) => ByteSliceHex.MakeHexApplier(pName, nullable, logger),
            null when ReflectedTypes.IsAtomicValueType(core) => AtomicValueLeaves.MakeColorApplier(pName, game.Annotations.HasAlphaLeaf(prop), logger),
            null when ReflectedTypes.IsVectorStructType(core) => VectorStructLeaves.MakeVectorApplier(prop, core, game, logger),
            _ => null,
        };
        return writer is null
            ? LeafWrite.ReadOnly<TTarget>(SchemaRefusals.NoConverterReason)
            : LeafWrite.Writable<TTarget>(writer);
    }

    private static JsonElement TranslatedStringValue(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return v;
        return v.TryGetProperty("Value", out var value) ? value : JsonDocument.Parse("\"\"").RootElement;
    }

    // Answers ApplyOutcome like MakeApplier so a malformed FormLink write is a real refusal, not a
    // silent no-op that re-serializes the record unchanged.
    internal static ApplyOutcome ApplyFormLinkJson(object obj, JsonElement val, string pName, ILogger logger)
    {
        try
        {
            var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
            if (rp == null) return ApplyOutcome.PropertyNotFound;
            if (val.ValueKind == JsonValueKind.Null)
            {
                (rp.GetValue(obj))?.GetType().GetMethod("Clear")?.Invoke(rp.GetValue(obj), []);
                return ApplyOutcome.Applied;
            }
            // GetString throws for any non-string token (a bare number, which ValidateFormLinks lets
            // through as "no reference"); caught below like every other conversion failure.
            var fkStr = val.GetString();
            if (fkStr == null || !FormKey.TryFactory(fkStr, out var fk)) return ApplyOutcome.ValueRejected;
            var link = rp.GetValue(obj);
            var setTo = link?.GetType().GetMethod("SetTo", [typeof(FormKey)]);
            if (setTo == null) return ApplyOutcome.ValueRejected;
            setTo.Invoke(link, [fk]);
            return ApplyOutcome.Applied;
        }
        catch (Exception ex)
        {
            if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
            return ApplyOutcome.ValueRejected;
        }
    }

    /// <summary>The converters signal a wrong token kind, an unrecognised enum member or an unparseable
    /// number by throwing, never by returning null, so this list is what turns a declined value into
    /// a refusal.</summary>
    internal static bool IsDecliningConverterException(Exception ex) =>
        ex is FormatException or OverflowException or InvalidCastException
            or ArgumentException or InvalidOperationException;
}
