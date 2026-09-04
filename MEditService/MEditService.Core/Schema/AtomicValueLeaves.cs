using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>A CLR value type Loqui does not model and that falls through every structural test —
/// presented as the named scalar components a table entry says it decomposes into, rather than as a
/// new handler branch per type. Exactly one entry today: System.Drawing.Color. A write stages the
/// components on a mutable box and rebuilds the whole immutable value once.</summary>
internal static class AtomicValueLeaves
{
    // #649: a CLR value type that Loqui does not model, so it has no sub-schema of its own and
    // falls through every structural test LeafClassification.ClassifyLeaf and ReflectedTypes make
    // (not a primitive, not an enum, not a form link, not
    // a Loqui interface, not a list, not a Noggog vector). Rather than a new handler branch per
    // type, each one is a row in this table saying which named scalar components it decomposes
    // into — the "not Loqui-modelled ⇒ value" rule, applied by lookup.
    //
    // Exactly one entry today: System.Drawing.Color. Every other unmodelled value type reachable in
    // the walk is a named exclusion instead (AtomicValueExclusions) — a table entry is a rendered
    // presentation, and only Color's has been decided.
    //
    // Components are named the way xEdit names them (Red/Green/Blue/Alpha -> red/green/blue/alpha),
    // not the way the CLR type does (R/G/B/A), because the wire name is what reaches the grid and
    // ADR-0034 makes xEdit the vocabulary for anything a user reads. The CLR name is kept alongside
    // it: it is what both the Extract (reads off the real Color) and the Apply (writes onto the
    // mutable staging box below) resolve by reflection, so neither has to know about the rename.
    private sealed record AtomicValueComponent(string WireName, string ClrName);

    private static readonly AtomicValueComponent[] ColorRgbComponents =
    [
        new("red", "R"), new("green", "G"), new("blue", "B"),
    ];

    private static readonly AtomicValueComponent[] ColorRgbaComponents =
    [
        new("red", "R"), new("green", "G"), new("blue", "B"), new("alpha", "A"),
    ];

    // The components this property decomposes into. Per-property rather than per-type precisely
    // because of the alpha allowlist: two fields of the identical CLR type get different shapes.
    private static AtomicValueComponent[] AtomicValueComponentsFor(GameReflection game, PropertyInfo prop) =>
        game.Annotations.HasAlphaLeaf(prop) ? ColorRgbaComponents : ColorRgbComponents;

    // The mutable staging target an atomic value's Apply writes onto before the immutable value is
    // rebuilt from it. System.Drawing.Color's own R/G/B/A are get-only, so the vector-struct trick
    // of mutating a boxed value in place is structurally unavailable here — but with a box whose
    // property *names* match the CLR type's, every component still gets an ordinary LeafWriters.MakeApplier and
    // the whole write folds through the same SubFieldValues.ApplySubFields every other struct uses. No bespoke
    // per-component write path, and no read-only component anywhere in the shape.
    private sealed class ColorComponentBox
    {
        public byte R { get; set; }
        public byte G { get; set; }
        public byte B { get; set; }
        public byte A { get; set; }
    }

    // One component's own sub-field. Read and write deliberately target different runtime types:
    // Extract reads off the real immutable value (a System.Drawing.Color), while Apply resolves the
    // same CLR name on the mutable ColorComponentBox the enclosing Apply stages into. Both are
    // ordinary name-keyed reflection — ReflectedTypes.SubGetter and LeafWriters.MakeApplier, unchanged — so a component behaves
    // exactly like any other byte leaf, ApplyOutcome folding included.
    private static List<SubFieldSpec> BuildAtomicValueComponentSubFields(
        Type core, AtomicValueComponent[] components, ILogger logger)
    {
        var (_, apiType, converter) = LeafClassification.PrimitiveMap[typeof(byte)];
        var result = new List<SubFieldSpec>();
        foreach (var component in components)
        {
            var componentProp = core.GetProperty(component.ClrName, BindingFlags.Public | BindingFlags.Instance)
                ?? throw new InvalidOperationException(
                    $"Atomic value type {core.Name} declares no '{component.ClrName}' component. " +
                    "The presentation table and the CLR type have diverged.");

            result.Add(new(component.WireName, apiType, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                ReflectedTypes.SubGetter(componentProp),
                LeafWrite.Writable(LeafWriters.MakeApplier(component.ClrName, nullable: false, converter, logger))));
        }
        return result;
    }

    // Rebuilds the immutable value from the staged box. Alpha rides through whether or not this
    // field renders an alpha leaf: a field on the 3-leaf shape simply never has "alpha" in its
    // payload, so SubFieldValues.ApplySubFields leaves box.A at whatever the current value already carried — which
    // is what makes a colour edit on one of the 40 wbByteColors fields preserve its existing fourth
    // byte instead of silently zeroing it.
    private static System.Drawing.Color RebuildAtomicValue(ColorComponentBox box) =>
        System.Drawing.Color.FromArgb(box.A, box.R, box.G, box.B);

    private static ColorComponentBox StageAtomicValue(object? current) =>
        current is System.Drawing.Color c
            ? new ColorComponentBox { R = c.R, G = c.G, B = c.B, A = c.A }
            // No prior value (a nullable Color being written for the first time). All-zero matches
            // xEdit's own wbByteColors defaults (aDefaultR/G/B = 0, the fourth byte wbUnused).
            : new ColorComponentBox();

    // The shared write body for an atomic value, operating on `object` so the top-level column and
    // the nested sub-field share one implementation — the same posture StructLeaves.ApplyStructJson takes for
    // Loqui structs since #643.
    private static ApplyOutcome ApplyAtomicValueJson(
        object obj, JsonElement val, string pName, IReadOnlyList<SubFieldSpec> components)
    {
        if (val.ValueKind != JsonValueKind.Object) return ApplyOutcome.ValueRejected;
        var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;

        var box = StageAtomicValue(rp.GetValue(obj));
        var subOutcome = SubFieldValues.ApplySubFields(box, val, components);
        if (subOutcome != ApplyOutcome.Applied) return subOutcome;
        if (rp.CanWrite) rp.SetValue(obj, RebuildAtomicValue(box));
        return ApplyOutcome.Applied;
    }

    internal static SubFieldSpec BuildAtomicValueSubField(
        PropertyInfo prop, Type core, string colName, GameReflection game, ILogger logger)
    {
        var components = BuildAtomicValueComponentSubFields(core, AtomicValueComponentsFor(game, prop), logger);
        var g = ReflectedTypes.SubGetter(prop);
        var pName = prop.Name;
        return new(colName, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            obj => { var v = g(obj); return v == null ? null : SubFieldValues.ExtractSubObject(v, components); },
            Apply: LeafWrite.Writable<object>((obj, val) => ApplyAtomicValueJson(obj, val, pName, components)),
            SubFields: components,
            LeafTypeName: ReflectedTypes.StructTypeName(core));
    }

    internal static ColumnInfoResult BuildAtomicValueColumn(PropertyInfo prop, Type core, GameReflection game, ILogger logger)
    {
        var components = BuildAtomicValueComponentSubFields(core, AtomicValueComponentsFor(game, prop), logger);
        var pName = prop.Name;
        return new("VARCHAR",
            r => ReflectedTypes.ReadOrNull(r, prop) is { } v ? JsonSerializer.Serialize(SubFieldValues.ExtractSubObject(v, components)) : null,
            "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            Apply: LeafWrite.Writable<IMajorRecord>((record, val) => ApplyAtomicValueJson(record, val, pName, components)),
            SubFieldMetas: components.ConvertAll(c => c.ToFieldMetadata()),
            LeafTypeName: ReflectedTypes.StructTypeName(core));
    }
}
