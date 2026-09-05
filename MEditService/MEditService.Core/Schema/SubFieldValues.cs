using System.Text.Json;

namespace MEditService.Core.Schema;

/// <summary>Folds a JSON object's members back onto one object. Shared by every composite leaf
/// kind, which differ only in what object the members hang off.</summary>
internal static class SubFieldValues
{
    /// <summary>A member absent from the JSON is never targeted. Naming one with no writer is a silent
    /// skip for a discriminator and <see cref="ApplyOutcome.SubFieldReadOnly"/> otherwise; a rejected
    /// member fails the whole object.</summary>
    internal static ApplyOutcome ApplySubFields(object target, JsonElement json, IReadOnlyList<SubFieldSpec> subFields)
    {
        var rejected = false;
        var notWritable = false;
        var elementTypeUnresolved = false;
        foreach (var sf in subFields)
        {
            if (!json.TryGetProperty(sf.Name, out var sfVal)) continue;
            if (sf.Apply.Writer is not { } apply)
            {
                if (sf.TargetingRefuses) notWritable = true;
                continue;
            }
            // Folded against every failure value: a member's own apply can be a nested struct or list
            // write answering SubFieldReadOnly or ListElementTypeUnresolved, and neither may vanish
            // one level up.
            switch (apply(target, sfVal))
            {
                case ApplyOutcome.SubFieldReadOnly: notWritable = true; break;
                case ApplyOutcome.ListElementTypeUnresolved: elementTypeUnresolved = true; break;
                case ApplyOutcome.ValueRejected: rejected = true; break;
            }
        }
        // Most-specific diagnosis first: "no write door" beats "name a discriminator", which beats
        // "send a value this field accepts".
        if (notWritable) return ApplyOutcome.SubFieldReadOnly;
        if (elementTypeUnresolved) return ApplyOutcome.ListElementTypeUnresolved;
        return rejected ? ApplyOutcome.ValueRejected : ApplyOutcome.Applied;
    }
}
