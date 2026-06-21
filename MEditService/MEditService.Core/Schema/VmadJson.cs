namespace MEditService.Core.Schema;

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
