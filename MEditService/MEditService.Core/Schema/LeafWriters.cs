using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>How a leaf's value gets onto an object: resolving the property off the receiver's
/// runtime type, and the appliers a converted JSON value, a form link, or a declining converter
/// each need. Every leaf write in the reflected schema goes through <see cref="SetOrDecline"/>.</summary>
internal static class LeafWriters
{
    // Shared by MakeApplier and WidenedLeaf.MakeWidenedApplier — an applier's target *type* varies per
    // call (a struct/array sub-field's own object can be any of several concrete runtime types,
    // OMOD's seven leaves included), while the property *name* it looks for is fixed for the life
    // of the closure, so the cache is keyed on the former and captured once per the latter.
    internal static Func<Type, PropertyInfo?> ResolveProperty(string pName)
    {
        var cache = new ConcurrentDictionary<Type, PropertyInfo?>();
        return t => cache.GetOrAdd(t, tt => tt.GetProperty(pName, BindingFlags.Public | BindingFlags.Instance));
    }

    /// <summary>Every leaf applier's own write. <see cref="ResolveProperty"/> resolves off the
    /// receiver's <i>runtime</i> type, so this is an open-world call: a same-named property of
    /// another shape declines the value (<see cref="ArgumentException"/>) instead of throwing out
    /// of the write path.</summary>
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

    // The one applier shared by columns and sub-fields: writes a converted JSON value onto a
    // property. Operates on `object`, which a column path takes as-is (Func is contravariant).
    //
    // Answers ApplyOutcome rather than being a void Action so each caller can tell a real
    // refusal (ValueRejected, PropertyNotFound at the top-level-column layer) from the sub-field
    // layer's own expected silent no-op (PropertyNotFound there — see SubFieldValues.ApplySubFields); a void
    // return would swallow every way this can fail to write (no such property on the runtime type,
    // a JSON null into a non-nullable column, a converter that threw or declined).
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
            // None of LeafClassification's PrimitiveMap or ClassifyEnumLeaf converters ever return null
            // on invalid input — GetInt32/GetBoolean/GetString throw InvalidOperationException for
            // the wrong JSON token kind, Enum.Parse throws ArgumentException for an unrecognised
            // member, and the bitmask branch's long.Parse throws FormatException — so this catch,
            // not the null-return guard below, is what turns a declining converter into a
            // ValueRejected instead of an uncaught throw. Same catch list
            // WidenedLeaf.ConvertWidenedJson already uses, widened with ArgumentException/InvalidOperationException
            // for the two dispatch shapes that method doesn't need to cover.
            catch (Exception ex) when (IsDecliningConverterException(ex))
            {
                if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
                return ApplyOutcome.ValueRejected;
            }

            if (v == null) return ApplyOutcome.ValueRejected;
            return SetOrDecline(rp, obj, v, pName, logger);
        };
    }

    /// <summary>The one place a classified leaf becomes a write, or a named refusal. A generic leaf
    /// (primitive, enum, translated string) carries its own converter; a form link and a byte slice
    /// each get the applier that knows their grammar; anything left has no way to take a value and
    /// says so. Generic in the receiver because the writer resolves its property off the target's
    /// runtime type either way — a top-level column passes the record, a sub-field passes whichever
    /// struct or array element encloses it, and delegate contravariance makes that one body.</summary>
    internal static LeafWrite<TTarget> RouteWriter<TTarget>(
        LeafSpec leaf, Type core, string pName, bool nullable, ILogger logger)
        where TTarget : class
    {
        Func<object, JsonElement, ApplyOutcome>? writer = leaf.Convert switch
        {
            { } c => MakeApplier(pName, nullable, c, logger),
            null when ReflectedTypes.IsFormLink(core) => (obj, val) => ApplyFormLinkJson(obj, val, pName, logger),
            null when ByteSliceHex.IsByteSlice(core) => ByteSliceHex.MakeHexApplier(pName, nullable, logger),
            _ => null,
        };
        return writer is null
            ? LeafWrite.ReadOnly<TTarget>(SchemaRefusals.NoConverterReason)
            : LeafWrite.Writable<TTarget>(writer);
    }

    // Answers ApplyOutcome the same way MakeApplier does, so a top-level
    // FormLink column's own malformed-value write (a missing property, an unparseable FormKey
    // string, a JSON value that isn't even a string) is a real refusal rather than a silent no-op
    // that still re-serializes the record unchanged and calls it applied.
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
            // GetString() throws InvalidOperationException for any JSON token kind other than string
            // (e.g. a bare number sent for a nullable FormLink column, which ValidateFormLinks itself
            // treats as "no reference" and lets through) — caught below, same as every other
            // conversion failure this method can hit.
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

    /// <summary>A converter declining its input, as opposed to a defect. <c>LeafClassification.PrimitiveMap</c>'s and
    /// <c>LeafClassification.ClassifyEnumLeaf</c>'s converters signal a wrong JSON token kind, an unrecognised enum
    /// member or an unparseable number by throwing — <c>GetInt32</c>/<c>GetBoolean</c> throw
    /// <see cref="InvalidOperationException"/>, <c>Enum.Parse</c> throws
    /// <see cref="ArgumentException"/>, <c>long.Parse</c> throws <see cref="FormatException"/> — so
    /// this list, not a null return, is what turns a declined value into a refusal.</summary>
    internal static bool IsDecliningConverterException(Exception ex) =>
        ex is FormatException or OverflowException or InvalidCastException
            or ArgumentException or InvalidOperationException;
}
