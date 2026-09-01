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
/// VMAD/condition reconstitution from a record's document body. <c>GetVmad</c>/<c>GetConditions</c>
/// are deliberately not <see cref="Records.IRecordReads"/> members (raw-SQL and per-capability
/// members are both ruled out for the seam); the capability lives at the query-service level
/// instead — deserializing <see cref="RecordDocument.Body"/> through <see cref="RecordTextCodec"/>
/// and walking the same <c>VmadCodec</c>/<see cref="IConditionCodec"/>.
/// </summary>
internal static class RecordDocumentCodecs
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    // Missing data reads as null/empty, never a throw: a document this codec cannot reconstitute
    // reads as "no VMAD", the same as a record that simply carries none. See Deserialize for the two
    // cases that reach that.
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

    // Owners are re-sorted by FieldPath (ordinal): Extract's own discovery order (reflection order
    // for flat fields, then nested owners appended after) is not a stable presentation order.
    //
    // A document this codec cannot reconstitute reads as "no conditions", same as GetVmad's
    // null-VMAD case.
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

    /// <summary>
    /// The document as a live record, or null when this codec structurally cannot produce one.
    ///
    /// <para><b>The plugin header is refused by name, and it has to be.</b> Its body is a real
    /// document like every other row's since #631 — the whole-mod door's root
    /// <c>RecordData.json</c> — but a ModHeader is not an <see cref="IMajorRecordGetter"/>, so the
    /// per-record codec cannot read it: handed the header's <c>record_type</c> it takes the
    /// self-describing path, finds no <c>MutagenObjectType</c>, and throws
    /// <c>RecordTypeSerializationUnsupportedException</c>. Both capabilities here are structurally
    /// impossible for a header anyway (<c>RecordTableSchema.HasVmad</c> is false for it, and a
    /// ModHeader owns no condition list), so "no VMAD, no conditions" is the honest answer rather
    /// than a swallowed failure.</para>
    ///
    /// <para>This used to be a null-<c>Body</c> check, which answered the same question only because
    /// the header was the one document-less row. That is no longer true, and a null body would now
    /// mean something quite different — so the guard names what it actually excludes.</para>
    /// </summary>
    private static IMajorRecord? Deserialize(RecordDocument document, GameRelease release) =>
        document.RecordType == HeaderIndexer.RecordType || document.Body is not { } body
            ? null
            : Codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), release, document.RecordType)
                .GetAwaiter().GetResult();

    // Only a Number-category parameter is ever decodable (Form/Text are already
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
