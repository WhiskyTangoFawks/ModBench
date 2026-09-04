using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>A CLR value type Loqui does not model, presented as the scalar components a table entry
/// names. One entry: System.Drawing.Color. A write stages onto a mutable box and rebuilds the
/// immutable value once.</summary>
internal static class AtomicValueLeaves
{
    // Components carry xEdit's names (red/green/blue/alpha), since ADR-0034 makes xEdit the vocabulary
    // for anything a user reads, alongside the CLR name both Extract and Apply resolve by reflection.
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

    // System.Drawing.Color's R/G/B/A are get-only, so the write stages onto this box, whose property
    // names match the CLR type's, and every component gets an ordinary LeafWriters.MakeApplier.
    private sealed class ColorComponentBox
    {
        public byte R { get; set; }
        public byte G { get; set; }
        public byte B { get; set; }
        public byte A { get; set; }
    }

    // Extract reads the real immutable value; Apply resolves the same CLR name on the ColorComponentBox
    // the enclosing Apply stages into.
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

    // Alpha rides through unchanged: a 3-leaf field never names "alpha", so box.A keeps whatever the
    // record carried instead of being zeroed.
    private static System.Drawing.Color RebuildAtomicValue(ColorComponentBox box) =>
        System.Drawing.Color.FromArgb(box.A, box.R, box.G, box.B);

    private static ColorComponentBox StageAtomicValue(object? current) =>
        current is System.Drawing.Color c
            ? new ColorComponentBox { R = c.R, G = c.G, B = c.B, A = c.A }
            // No prior value (a nullable Color being written for the first time). All-zero matches
            // xEdit's own wbByteColors defaults (aDefaultR/G/B = 0, the fourth byte wbUnused).
            : new ColorComponentBox();

    // Operates on object so the column and the nested sub-field share one write body.
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
            LeafTypeName: ReflectedTypes.LeafTypeName(core));
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
            LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }
}
