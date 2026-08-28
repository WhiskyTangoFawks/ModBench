namespace MEditService.Core.Records;

// Per-plugin assembled VMAD tree — GetVmad's hydration shape, built by walking the record's own
// reconstituted document through VmadCodec (#420; before then, hydrated from the now-deleted
// vmad_scripts/vmad_properties/vmad_property_list_items relational rows instead). Input to
// cross-plugin alignment, NOT the wire format.

// A named child within a script or struct — members align across plugins by Name.
// Positional record => Deconstruct((Name, Value)) so callers can destructure like a tuple.
public sealed record VmadNamedValue(string Name, VmadPropertyValue Value);

public sealed record VmadPropertyValue(
    string Type,
    string Flags,
    object? Value,
    short? Alias = null,
    IReadOnlyList<VmadPropertyValue>? ListItems = null,                 // scalar-array elements & ArrayOfObject
    IReadOnlyList<VmadNamedValue>? Members = null,                      // Struct members (recursive, by name)
    IReadOnlyList<IReadOnlyList<VmadNamedValue>>? StructList = null);   // ArrayOfStruct: each instance = named members

public sealed record VmadScriptData(
    string Name,
    string Flags,
    IReadOnlyList<VmadNamedValue> Properties);

public sealed record VmadData(IReadOnlyList<VmadScriptData> Scripts);
