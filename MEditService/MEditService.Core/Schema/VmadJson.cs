using System.Text.Json;
using System.Text.Json.Serialization;

namespace MEditService.Core.Schema;

// Shared (de)serializer for the struct_json column. Both the index walk (VmadIndexer)
// and the query hydration (GetVmad) go through these so the serialized shape stays aligned.
public static class VmadJson
{
    public static readonly JsonSerializerOptions Options =
        new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public static string SerializeStruct(VmadStructEntry[] members) =>
        JsonSerializer.Serialize(members, Options);

    public static string SerializeStructList(VmadStructInstance[] instances) =>
        JsonSerializer.Serialize(instances, Options);

    // struct_json is always a serialized array written by Serialize* (never the literal "null"),
    // so Deserialize never returns null here.
    public static VmadStructEntry[] DeserializeStruct(string json) =>
        JsonSerializer.Deserialize<VmadStructEntry[]>(json, Options)!;

    public static VmadStructInstance[] DeserializeStructList(string json) =>
        JsonSerializer.Deserialize<VmadStructInstance[]>(json, Options)!;
}

// struct_json payload for ScriptStructProperty: each member is a named ScriptEntry with its own properties.
public sealed record VmadStructEntry(
    string Name,
    string Flags,
    VmadPropertyNode[] Properties);

// struct_json payload for ScriptStructListProperty: each element is a ScriptEntryStructs with flat members.
public sealed record VmadStructInstance(
    VmadPropertyNode[] Members);

// A single scalar property within a struct member tree.
public sealed record VmadPropertyNode(
    string Name,
    string Type,
    string Flags,
    bool? BoolValue = null,
    int? IntValue = null,
    float? FloatValue = null,
    string? StringValue = null,
    string? FormKeyValue = null,
    short? AliasValue = null);
