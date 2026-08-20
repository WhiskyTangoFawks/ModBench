using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Queries;

/// <summary>
/// VMAD/condition reconstitution from a record's document body (#413 D1 / #420's pattern) —
/// relocated here from <c>Records/DuckDbRecordIndex</c> by #421's reshape. <c>GetVmad</c>/
/// <c>GetConditions</c> are rejected from <see cref="Records.IRecordReads"/> outright (raw-SQL and
/// per-capability members were both explicitly ruled out for the seam); the capability survives at
/// the query-service level instead, exactly as the ticket's own amendment describes it —
/// deserializing <see cref="RecordDocument.Body"/> through <see cref="RecordTextCodec"/> and
/// walking the same <c>VmadCodec</c>/<see cref="IConditionCodec"/> this logic always used. Moved
/// verbatim, not reimplemented, so the values stay byte-identical.
/// </summary>
internal static class RecordDocumentCodecs
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    // Invariant 7 (missing data reads as null/empty, never a throw): a null Body — the header
    // (D8: never an IMajorRecordGetter, so it never had a document) — reads as "no VMAD", the same
    // as a record that simply carries none.
    public static VmadData? GetVmad(RecordDocument document, GameRelease release, ILogger logger)
    {
        if (Deserialize(document, release) is not IHaveVirtualMachineAdapterGetter { VirtualMachineAdapter: { } vmad })
            return null;
        if (vmad.Scripts.Count == 0) return null;

        var scripts = new List<VmadScriptData>();
        foreach (var script in vmad.Scripts)
        {
            var props = new List<VmadNamedValue>();
            foreach (var property in script.Properties)
            {
                if (VmadCodec.Parse(property) is not { } parsed)
                {
                    logger.LogWarning("Unknown VMAD property type {Type} on {FormKey}\\{Script}\\{Prop}",
                        property.GetType().Name, document.FormKey, script.Name, property.Name);
                    continue;
                }

                props.Add(new VmadNamedValue(property.Name, MapVmadProperty(parsed)));
            }

            scripts.Add(new VmadScriptData(script.Name, VmadCodec.FlagsString(script.Flags), props));
        }

        return new VmadData(scripts);
    }

    // Owners are re-sorted by FieldPath (ordinal) because Extract's own discovery order (reflection
    // order for flat fields, then nested owners appended after) does not match the pre-#420 SQL's
    // `ORDER BY owner_field_path` — deliberate behaviour-preservation, carried over unchanged.
    //
    // Invariant 7: a null Body reads as "no conditions", same as GetVmad's null-VMAD case.
    public static IReadOnlyList<ConditionOwner> GetConditions(RecordDocument document, GameRelease release, IConditionCodec? conditionCodec)
    {
        if (conditionCodec == null) return [];
        if (Deserialize(document, release) is not IMajorRecordGetter record) return [];

        return [.. conditionCodec.Extract(record)
            .OrderBy(o => o.FieldPath, StringComparer.Ordinal)
            .Select(o => o with
            {
                Conditions = [.. o.Conditions.Select(c => c with
                {
                    Parameters = [.. c.Parameters.Select(p => p with
                    {
                        DecodedValue = DecodeParamValue(conditionCodec, p.Category.ToString(), p.TypeName, p.Number),
                    })],
                })],
            })];
    }

    private static IMajorRecord? Deserialize(RecordDocument document, GameRelease release) =>
        document.Body is not { } body
            ? null
            : Codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), release).GetAwaiter().GetResult();

    // #165: only a Number-category parameter is ever decodable (Form/Text are already
    // human-legible); a Form/Text row's stored number_value is null regardless of category, so this
    // also guards the null-Number case a Number row itself can never actually hit (Number.Value is
    // always non-null once category checks out).
    private static string? DecodeParamValue(IConditionCodec conditionCodec, string category, string typeName, int? number) =>
        category == nameof(ConditionParamCategory.Number) && number is { } n
            ? conditionCodec.DecodeParamValue(typeName, n)
            : null;

    // Types with an element type are the ones whose elements come from VmadParsedProperty.Items.
    private static VmadPropertyValue MapVmadProperty(VmadParsedProperty parsed) =>
        VmadCodec.ElementType(parsed.Type) is { } elementType
            ? new VmadPropertyValue(parsed.Type, parsed.Flags, null, ListItems: MapVmadItems(elementType, parsed.Items))
            : MapNonArrayVmadProperty(parsed);

    private static VmadPropertyValue MapNonArrayVmadProperty(VmadParsedProperty parsed) => parsed.Type switch
    {
        "Bool" => new VmadPropertyValue(parsed.Type, parsed.Flags, parsed.Value.BoolValue),
        "Int" => new VmadPropertyValue(parsed.Type, parsed.Flags, parsed.Value.IntValue),
        "Float" => new VmadPropertyValue(parsed.Type, parsed.Flags, parsed.Value.FloatValue),
        "String" => new VmadPropertyValue(parsed.Type, parsed.Flags, parsed.Value.StringValue),
        "Object" => new VmadPropertyValue(parsed.Type, parsed.Flags, parsed.Value.FormKeyValue, parsed.Value.AliasValue),
        "Struct" => new VmadPropertyValue(parsed.Type, parsed.Flags, null, Members: MapStructMembers(parsed.StructJson)),
        "ArrayOfStruct" => new VmadPropertyValue(parsed.Type, parsed.Flags, null, StructList: MapStructList(parsed.StructJson)),
        _ => new VmadPropertyValue(parsed.Type, parsed.Flags, null),
    };

    private static List<VmadNamedValue>? MapStructMembers(string? structJson) =>
        structJson is null
            ? null
            : [.. VmadCodec.StructMembers(structJson).Select(n => new VmadNamedValue(n.Name, MapNode(n)))];

    private static List<IReadOnlyList<VmadNamedValue>>? MapStructList(string? structJson)
    {
        return structJson is null
            ? null
            : ([.. VmadJson.DeserializeStructList(structJson).Select(inst => (IReadOnlyList<VmadNamedValue>)MapNodes(inst.Members))]);
    }

    private static List<VmadNamedValue> MapNodes(VmadPropertyNode[] nodes) =>
        [.. nodes.Select(n => new VmadNamedValue(n.Name, MapNode(n)))];

    private static VmadPropertyValue MapNode(VmadPropertyNode n) => n.Type switch
    {
        "Bool" => new VmadPropertyValue(n.Type, n.Flags, n.BoolValue),
        "Int" => new VmadPropertyValue(n.Type, n.Flags, n.IntValue),
        "Float" => new VmadPropertyValue(n.Type, n.Flags, n.FloatValue),
        "String" => new VmadPropertyValue(n.Type, n.Flags, n.StringValue),
        "Object" => new VmadPropertyValue(n.Type, n.Flags, n.FormKeyValue, n.AliasValue),
        "Struct" => new VmadPropertyValue(n.Type, n.Flags, null, Members: MapNodes(n.Members ?? [])),
        _ => new VmadPropertyValue(n.Type, n.Flags, null),
    };

    // Array elements carry no per-element flags (flags live at the property level only), hence "".
    // elementType is resolved once by the caller (VmadCodec.ElementType(parsed.Type)) since every
    // item of one property shares its owning property's element type.
    private static List<VmadPropertyValue> MapVmadItems(string elementType, IReadOnlyList<VmadValue>? items) =>
        items is null
            ? []
            : [.. items.Select(v => elementType switch
            {
                "Bool" => new VmadPropertyValue("Bool", "", v.BoolValue),
                "Int" => new VmadPropertyValue("Int", "", v.IntValue),
                "Float" => new VmadPropertyValue("Float", "", v.FloatValue),
                "String" => new VmadPropertyValue("String", "", v.StringValue),
                "Object" => new VmadPropertyValue("Object", "", v.FormKeyValue, v.AliasValue),
                _ => new VmadPropertyValue(elementType, "", null),
            })];
}
