using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Schema;

// A parsed leaf value: exactly one of these is set for a given VMAD type. Callers decide
// how to store it (the index spreads it across typed columns).
public readonly record struct VmadValue(
    bool? BoolValue = null,
    int? IntValue = null,
    float? FloatValue = null,
    string? StringValue = null,
    string? FormKeyValue = null,
    short? AliasValue = null);

// A FormKey referenced from inside a property, with its path relative to the property
// itself: "" for the property, "[i]" for an array element, "\Member" for a struct member.
public sealed record VmadFormRef(string RelativePath, string FormKey);

// One VMAD property in model form: its type and flags, its leaf value (or per-element
// values for element-bearing arrays, or serialized struct JSON), and the FormKeys it references.
public sealed record VmadParsedProperty(
    string Type,
    string Flags,
    VmadValue Value = default,
    IReadOnlyList<VmadValue>? Items = null,
    string? StructJson = null)
{
    public IReadOnlyList<VmadFormRef> Refs { get; init; } = [];
}

// Outcome of applying a value onto a Mutagen VMAD property. Callers in the Edits context
// map this onto their own per-change outcome.
public enum VmadApplyResult
{
    Applied,
    ReadOnly,
    NotFound,
}

// VMAD's Mutagen edge: the property-type taxonomy, the editability policy, and (in later
// slices) parse and apply. VMAD sits outside the reflection-driven schema pipeline
// (ADR-0005, ADR-0019), so this is its ColumnSpec equivalent — the one place a new or
// changed VMAD property type is described. Does no I/O: no SQL, no disk.
public static class VmadCodec
{
    // Array types whose elements are stored one row per element. ArrayOfStruct is absent
    // deliberately: its elements live in struct_json, not in list-item rows.
    private static readonly Dictionary<string, string> ElementTypes = new(StringComparer.Ordinal)
    {
        ["ArrayOfBool"] = "Bool",
        ["ArrayOfInt"] = "Int",
        ["ArrayOfFloat"] = "Float",
        ["ArrayOfString"] = "String",
        ["ArrayOfObject"] = "Object",
    };

    // The element type of an element-bearing array type, or null if the type has no such elements.
    public static string? ElementType(string type) =>
        ElementTypes.TryGetValue(type, out var element) ? element : null;

    // The property types stageable as plain field edits. Struct/ArrayOfStruct are edited
    // through struct ops instead; Variable/ArrayOfVariable are not editable at all.
    private static readonly HashSet<string> EditableTypes = new(StringComparer.Ordinal)
    {
        "Bool", "Int", "Float", "String", "Object",
        "ArrayOfBool", "ArrayOfInt", "ArrayOfFloat", "ArrayOfString", "ArrayOfObject",
    };

    public static bool IsEditable(string type) => EditableTypes.Contains(type);

    // Empty property of the given VMAD type; its value is filled separately via ApplyValue.
    // Unknown / non-constructable (Variable) types are absent, so CreateDefault returns null.
    private static readonly Dictionary<string, Func<ScriptProperty>> DefaultPropertyFactories = new(StringComparer.Ordinal)
    {
        ["Bool"] = () => new ScriptBoolProperty(),
        ["Int"] = () => new ScriptIntProperty(),
        ["Float"] = () => new ScriptFloatProperty(),
        ["String"] = () => new ScriptStringProperty { Data = "" },
        ["Object"] = () => new ScriptObjectProperty { Alias = -1 },
        ["ArrayOfBool"] = () => new ScriptBoolListProperty(),
        ["ArrayOfInt"] = () => new ScriptIntListProperty(),
        ["ArrayOfFloat"] = () => new ScriptFloatListProperty(),
        ["ArrayOfString"] = () => new ScriptStringListProperty(),
        ["ArrayOfObject"] = () => new ScriptObjectListProperty(),
        ["Struct"] = () => new ScriptStructProperty(),
        ["ArrayOfStruct"] = () => new ScriptStructListProperty(),
    };

    public static ScriptProperty? CreateDefault(string type) =>
        DefaultPropertyFactories.TryGetValue(type, out var make) ? make() : null;

    // Applies a value (per-type payload shape from 13.4/13.6/13.7) into an existing property.
    public static VmadApplyResult ApplyValue(ScriptProperty prop, JsonElement value)
    {
        switch (prop)
        {
            case ScriptBoolProperty p: p.Data = value.GetBoolean(); break;
            case ScriptIntProperty p: p.Data = value.GetInt32(); break;
            case ScriptFloatProperty p: p.Data = value.GetSingle(); break;
            case ScriptStringProperty p: p.Data = value.GetString()!; break;
            case ScriptObjectProperty p: return ApplyObjectProperty(p, value);
            case ScriptBoolListProperty p: return RebuildList(p.Data, value, el => el.GetBoolean());
            case ScriptIntListProperty p: return RebuildList(p.Data, value, el => el.GetInt32());
            case ScriptFloatListProperty p: return RebuildList(p.Data, value, el => el.GetSingle());
            case ScriptStringListProperty p: return RebuildList(p.Data, value, el => el.GetString()!);
            case ScriptObjectListProperty p: return ApplyObjectListProperty(p, value);
            case ScriptStructProperty p: return ApplyStructProperty(p, value);
            case ScriptStructListProperty p: return ApplyStructListProperty(p, value);
            case ScriptVariableProperty:
            case ScriptVariableListProperty:
                return VmadApplyResult.ReadOnly;
            default:
                return VmadApplyResult.NotFound;
        }

        return VmadApplyResult.Applied;
    }

    private static bool TryParseScriptObject(JsonElement el, out FormKey fk, out short alias)
    {
        alias = 0;
        if (!el.TryGetProperty("formKey", out var fkEl) ||
            fkEl.GetString() is not string fkStr ||
            !FormKey.TryFactory(fkStr, out fk) ||
            !el.TryGetProperty("alias", out var aliasEl))
        {
            fk = default;
            return false;
        }
        if (aliasEl.ValueKind == JsonValueKind.Null) { fk = default; return false; }
        alias = aliasEl.GetInt16();
        return true;
    }

    private static VmadApplyResult ApplyObjectProperty(ScriptObjectProperty p, JsonElement value)
    {
        if (!TryParseScriptObject(value, out var fk, out var alias))
            return VmadApplyResult.NotFound;
        p.Object.SetTo(fk);
        p.Alias = alias;
        return VmadApplyResult.Applied;
    }

    private static VmadApplyResult RebuildList<T>(IList<T> list, JsonElement array, Func<JsonElement, T> parse)
    {
        if (array.ValueKind != JsonValueKind.Array) return VmadApplyResult.NotFound;
        list.Clear();
        foreach (var el in array.EnumerateArray()) list.Add(parse(el));
        return VmadApplyResult.Applied;
    }

    private static VmadApplyResult ApplyObjectListProperty(ScriptObjectListProperty p, JsonElement array)
    {
        if (array.ValueKind != JsonValueKind.Array) return VmadApplyResult.NotFound;
        var built = new List<ScriptObjectProperty>();
        foreach (var el in array.EnumerateArray())
        {
            if (!TryParseScriptObject(el, out var elFk, out var alias))
                return VmadApplyResult.NotFound;
            var obj = new ScriptObjectProperty { Alias = alias };
            obj.Object.SetTo(elFk);
            built.Add(obj);
        }
        p.Objects.Clear();
        foreach (var obj in built) p.Objects.Add(obj);
        return VmadApplyResult.Applied;
    }

    private static VmadApplyResult ApplyStructProperty(ScriptStructProperty p, JsonElement members)
    {
        if (members.ValueKind != JsonValueKind.Array || !TryBuildMembers(members, out var built))
            return VmadApplyResult.NotFound;
        // A Struct's fields live inside a single unnamed ScriptEntry wrapper in the binary format.
        var wrapper = new ScriptEntry();
        foreach (var m in built) wrapper.Properties.Add(m);
        p.Members.Clear();
        p.Members.Add(wrapper);
        return VmadApplyResult.Applied;
    }

    private static VmadApplyResult ApplyStructListProperty(ScriptStructListProperty p, JsonElement instances)
    {
        if (instances.ValueKind != JsonValueKind.Array) return VmadApplyResult.NotFound;
        var built = new List<ScriptEntryStructs>();
        foreach (var inst in instances.EnumerateArray())
        {
            if (inst.ValueKind != JsonValueKind.Array || !TryBuildMembers(inst, out var members))
                return VmadApplyResult.NotFound;
            var entry = new ScriptEntryStructs();
            foreach (var m in members) entry.Members.Add(m);
            built.Add(entry);
        }
        p.Structs.Clear();
        foreach (var entry in built) p.Structs.Add(entry);
        return VmadApplyResult.Applied;
    }

    private static bool TryBuildMembers(JsonElement array, out List<ScriptProperty> built)
    {
        built = [];
        if (array.ValueKind != JsonValueKind.Array) return false;
        foreach (var el in array.EnumerateArray())
        {
            if (!TryBuildMemberProperty(el, out var prop)) return false;
            built.Add(prop);
        }
        return true;
    }

    private static bool TryBuildMemberProperty(JsonElement node, out ScriptProperty prop)
    {
        prop = null!;
        if (node.ValueKind != JsonValueKind.Object) return false;
        if (!TryGetStringProperty(node, "name", out var name)) return false;
        if (!TryGetStringProperty(node, "type", out var type)) return false;

        var flags = ParseMemberFlags(node);
        return type switch
        {
            "Object" => TryBuildObjectMember(node, name, flags, out prop),
            "Struct" => TryBuildStructMember(node, name, flags, out prop),
            _ => TryBuildScalarMember(node, type, name, flags, out prop),
        };
    }

    private static bool TryGetStringProperty(JsonElement node, string propertyName, [NotNullWhen(true)] out string? value)
    {
        value = node.TryGetProperty(propertyName, out var el) ? el.GetString() : null;
        return value != null;
    }

    private static bool TryBuildScalarMember(
        JsonElement node, string type, string name, ScriptProperty.Flag flags, out ScriptProperty prop)
    {
        prop = null!;
        switch (type)
        {
            case "Bool" when node.TryGetProperty("boolValue", out var v):
                prop = new ScriptBoolProperty { Name = name, Flags = flags, Data = v.GetBoolean() }; break;
            case "Int" when node.TryGetProperty("intValue", out var v):
                prop = new ScriptIntProperty { Name = name, Flags = flags, Data = v.GetInt32() }; break;
            case "Float" when node.TryGetProperty("floatValue", out var v):
                prop = new ScriptFloatProperty { Name = name, Flags = flags, Data = v.GetSingle() }; break;
            case "String" when node.TryGetProperty("stringValue", out var v):
                prop = new ScriptStringProperty { Name = name, Flags = flags, Data = v.GetString()! }; break;
            default:
                return false;
        }
        return true;
    }

    // Struct member Object nodes carry formKeyValue/aliasValue (the VmadPropertyNode
    // wire shape), distinct from the {formKey, alias} shape used for top-level edits.
    // formKeyValue is a genuine JSON null for a null Object (matching the read projection's
    // IsNull guard) — that builds a member whose Object is left unset, not a failed parse.
    private static bool TryBuildObjectMember(
        JsonElement node, string name, ScriptProperty.Flag flags, out ScriptProperty prop)
    {
        prop = null!;
        if (!node.TryGetProperty("formKeyValue", out var fkEl))
            return false;

        FormKey? fk = null;
        if (fkEl.ValueKind != JsonValueKind.Null)
        {
            if (fkEl.GetString() is not string fkStr || !FormKey.TryFactory(fkStr, out var parsedFk))
                return false;
            fk = parsedFk;
        }

        var alias = node.TryGetProperty("aliasValue", out var aEl) && aEl.ValueKind == JsonValueKind.Number
            ? aEl.GetInt16()
            : (short)0;
        var obj = new ScriptObjectProperty { Name = name, Flags = flags, Alias = alias };
        if (fk is { } target) obj.Object.SetTo(target);
        prop = obj;
        return true;
    }

    private static bool TryBuildStructMember(
        JsonElement node, string name, ScriptProperty.Flag flags, out ScriptProperty prop)
    {
        prop = null!;
        if (!node.TryGetProperty("members", out var nested)) return false;
        if (!TryBuildMembers(nested, out var nestedBuilt)) return false;
        var wrapper = new ScriptEntry();
        foreach (var m in nestedBuilt) wrapper.Properties.Add(m);
        var sp = new ScriptStructProperty { Name = name, Flags = flags };
        sp.Members.Add(wrapper);
        prop = sp;
        return true;
    }

    private static ScriptProperty.Flag ParseMemberFlags(JsonElement node) =>
        node.TryGetProperty("flags", out var f) && f.GetString() is string s
            && Enum.TryParse<ScriptProperty.Flag>(s, out var parsed)
            ? parsed
            : 0;

    // Sets the value of an existing named property on an existing named script.
    public static VmadApplyResult ApplyFieldValue(
        IHaveVirtualMachineAdapter record, string scriptName, string propName, JsonElement value)
    {
        var prop = FindScript(record, scriptName) is { } script ? FindProperty(script, propName) : null;
        return prop == null ? VmadApplyResult.NotFound : ApplyValue(prop, value);
    }

    // Structural VMAD operations (phase 13.8) on a whole script.
    public static VmadApplyResult ApplyScriptOp(
        IHaveVirtualMachineAdapter record, string scriptName, string opName, JsonElement op) => opName switch
        {
            "add_script" => AddScript(record, scriptName, op),
            "remove_script" => RemoveScript(record.VirtualMachineAdapter, scriptName),
            "set_flags" => SetScriptFlags(record, scriptName, op),
            _ => VmadApplyResult.NotFound,
        };

    // Structural VMAD operations (phase 13.8) on a single property of a script.
    public static VmadApplyResult ApplyPropertyOp(
        IHaveVirtualMachineAdapter record, string scriptName, string propName, string opName, JsonElement op)
    {
        var script = FindScript(record, scriptName);
        return script == null
            ? VmadApplyResult.NotFound
            : opName switch
            {
                "add_property" => AddProperty(script, op),
                "remove_property" => RemoveProperty(script, propName),
                "set_type" => SetType(script, propName, op),
                "set_flags" => SetPropertyFlags(script, propName, op),
                _ => VmadApplyResult.NotFound,
            };
    }

    private static ScriptEntry? FindScript(IHaveVirtualMachineAdapter record, string scriptName) =>
        record.VirtualMachineAdapter?.Scripts.FirstOrDefault(s =>
            string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase));

    private static ScriptProperty? FindProperty(ScriptEntry script, string propName) =>
        script.Properties.FirstOrDefault(p =>
            string.Equals(p.Name, propName, StringComparison.OrdinalIgnoreCase));

    private static VmadApplyResult SetPropertyFlags(ScriptEntry script, string propName, JsonElement op)
    {
        var prop = FindProperty(script, propName);
        if (prop == null) return VmadApplyResult.NotFound;
        if (!op.TryGetProperty("flags", out var f) || f.GetString() is not string s
            || !Enum.TryParse<ScriptProperty.Flag>(s, out var parsed))
        {
            return VmadApplyResult.NotFound;
        }

        prop.Flags = parsed;
        return VmadApplyResult.Applied;
    }

    private static VmadApplyResult SetScriptFlags(
        IHaveVirtualMachineAdapter record, string scriptName, JsonElement op)
    {
        var script = FindScript(record, scriptName);
        if (script == null) return VmadApplyResult.NotFound;
        if (!op.TryGetProperty("flags", out var f) || f.GetString() is not string s
            || !Enum.TryParse<ScriptEntry.Flag>(s, out var parsed))
        {
            return VmadApplyResult.NotFound;
        }

        script.Flags = parsed;
        return VmadApplyResult.Applied;
    }

    // Replaces a property in place with a default-valued property of the target type, preserving
    // Name and Flags (mirrors xEdit's wbScriptPropertyTypeAfterSet, which resets the value).
    private static VmadApplyResult SetType(ScriptEntry script, string propName, JsonElement op)
    {
        if (!op.TryGetProperty("type", out var typeEl) || typeEl.GetString() is not string type)
            return VmadApplyResult.NotFound;

        var idx = -1;
        for (var i = 0; i < script.Properties.Count; i++)
        {
            if (string.Equals(script.Properties[i].Name, propName, StringComparison.OrdinalIgnoreCase))
            {
                idx = i;
                break;
            }
        }

        if (idx < 0) return VmadApplyResult.NotFound;

        var replacement = CreateDefault(type);
        if (replacement == null) return VmadApplyResult.NotFound;
        replacement.Name = script.Properties[idx].Name;
        replacement.Flags = script.Properties[idx].Flags;
        script.Properties[idx] = replacement;
        return VmadApplyResult.Applied;
    }

    private static VmadApplyResult AddScript(IHaveVirtualMachineAdapter record, string scriptName, JsonElement op)
    {
        // Attach an adapter to a record that has none (correct subtype per record via reflection).
        var vmad = record.VirtualMachineAdapter ?? CreateAdapter(record);
        if (vmad == null)
            return VmadApplyResult.NotFound;

        // A new script starts empty; properties are added individually via add_property.
        var entry = new ScriptEntry { Name = scriptName, Flags = ParseScriptFlags(op) };

        for (var i = vmad.Scripts.Count - 1; i >= 0; i--)
        {
            if (string.Equals(vmad.Scripts[i].Name, scriptName, StringComparison.OrdinalIgnoreCase))
                vmad.Scripts.RemoveAt(i);
        }

        vmad.Scripts.Add(entry);
        SortScripts(vmad);
        return VmadApplyResult.Applied;
    }

    // Removing the last script leaves an empty adapter (matches xEdit) rather than nulling it.
    private static VmadApplyResult RemoveScript(IAVirtualMachineAdapter? vmad, string scriptName)
    {
        if (vmad == null) return VmadApplyResult.NotFound;
        var removed = false;
        for (var i = vmad.Scripts.Count - 1; i >= 0; i--)
        {
            if (string.Equals(vmad.Scripts[i].Name, scriptName, StringComparison.OrdinalIgnoreCase))
            {
                vmad.Scripts.RemoveAt(i);
                removed = true;
            }
        }

        return removed ? VmadApplyResult.Applied : VmadApplyResult.NotFound;
    }

    private static void SortScripts(IAVirtualMachineAdapter vmad)
    {
        var sorted = vmad.Scripts.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ToList();
        vmad.Scripts.Clear();
        foreach (var s in sorted) vmad.Scripts.Add(s);
    }

    private static IAVirtualMachineAdapter? CreateAdapter(IHaveVirtualMachineAdapter record)
    {
        var prop = record.GetType().GetProperty(nameof(IHaveVirtualMachineAdapter.VirtualMachineAdapter));
        if (prop?.CanWrite != true || prop.PropertyType.IsAbstract) return null;
        if (System.Activator.CreateInstance(prop.PropertyType) is not IAVirtualMachineAdapter adapter) return null;
        prop.SetValue(record, adapter);
        return adapter;
    }

    private static ScriptEntry.Flag ParseScriptFlags(JsonElement op) =>
        op.TryGetProperty("flags", out var f) && f.GetString() is string s
            && Enum.TryParse<ScriptEntry.Flag>(s, out var parsed)
            ? parsed
            : ScriptEntry.Flag.Local;

    private static VmadApplyResult AddProperty(ScriptEntry script, JsonElement op)
    {
        if (!op.TryGetProperty("name", out var nameEl) || nameEl.GetString() is not string name
            || !op.TryGetProperty("type", out var typeEl) || typeEl.GetString() is not string type)
        {
            return VmadApplyResult.NotFound;
        }

        var prop = CreateDefault(type);
        if (prop == null)
            return VmadApplyResult.NotFound;
        prop.Name = name;
        prop.Flags = ParseStructOpFlags(op);

        if (op.TryGetProperty("value", out var value) && value.ValueKind != JsonValueKind.Null)
        {
            var outcome = ApplyValue(prop, value);
            if (outcome != VmadApplyResult.Applied) return outcome;
        }

        RemoveByName(script, name);
        script.Properties.Add(prop);
        SortProperties(script);
        return VmadApplyResult.Applied;
    }

    private static VmadApplyResult RemoveProperty(ScriptEntry script, string propName) =>
        RemoveByName(script, propName) ? VmadApplyResult.Applied : VmadApplyResult.NotFound;

    private static bool RemoveByName(ScriptEntry script, string name)
    {
        var removed = false;
        for (var i = script.Properties.Count - 1; i >= 0; i--)
        {
            if (string.Equals(script.Properties[i].Name, name, StringComparison.OrdinalIgnoreCase))
            {
                script.Properties.RemoveAt(i);
                removed = true;
            }
        }

        return removed;
    }

    private static void SortProperties(ScriptEntry script)
    {
        var sorted = script.Properties
            .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        script.Properties.Clear();
        foreach (var p in sorted) script.Properties.Add(p);
    }

    // The FormKeys carried by a staged VMAD value, in the { formKey, alias } shape used for
    // Object and ArrayOfObject edits. Any other value shape references nothing.
    public static IEnumerable<string> ValueFormKeys(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in value.EnumerateArray())
            {
                if (FormKeyOf(el) is { } elFk) yield return elFk;
            }
        }
        else if (FormKeyOf(value) is { } fk)
        {
            yield return fk;
        }
    }

    private static string? FormKeyOf(JsonElement el) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty("formKey", out var fkEl)
            && fkEl.ValueKind == JsonValueKind.String
            ? fkEl.GetString()
            : null;

    // Parses a Mutagen VMAD property into model form. Returns null for property types the
    // model has no representation for (Variable/ArrayOfVariable and anything Mutagen adds
    // later) — callers decide how to report that.
    public static VmadParsedProperty? Parse(IScriptPropertyGetter property) => property switch
    {
        IScriptBoolPropertyGetter p => Leaf(p, "Bool", new VmadValue(BoolValue: p.Data)),
        IScriptIntPropertyGetter p => Leaf(p, "Int", new VmadValue(IntValue: p.Data)),
        IScriptFloatPropertyGetter p => Leaf(p, "Float", new VmadValue(FloatValue: p.Data)),
        IScriptStringPropertyGetter p => Leaf(p, "String", new VmadValue(StringValue: p.Data)),
        IScriptObjectPropertyGetter p => ParseObject(p),
        IScriptBoolListPropertyGetter p => Array(p, "ArrayOfBool", [.. p.Data.Select(d => new VmadValue(BoolValue: d))]),
        IScriptIntListPropertyGetter p => Array(p, "ArrayOfInt", [.. p.Data.Select(d => new VmadValue(IntValue: d))]),
        IScriptFloatListPropertyGetter p => Array(p, "ArrayOfFloat", [.. p.Data.Select(d => new VmadValue(FloatValue: d))]),
        IScriptStringListPropertyGetter p => Array(p, "ArrayOfString", [.. p.Data.Select(d => new VmadValue(StringValue: d))]),
        IScriptObjectListPropertyGetter p => ParseObjectList(p),
        IScriptStructPropertyGetter p => ParseStruct(p),
        IScriptStructListPropertyGetter p => ParseStructList(p),
        _ => null,
    };

    // The members of a serialized Struct, with the binary format's unnamed ScriptEntry
    // wrapper flattened away so members surface directly.
    public static VmadPropertyNode[] StructMembers(string structJson) =>
        [.. VmadJson.DeserializeStruct(structJson).SelectMany(e => e.Properties)];

    private static VmadParsedProperty Leaf(IScriptPropertyGetter p, string type, VmadValue value) =>
        new(type, FlagsString(p.Flags), value);

    private static VmadParsedProperty Array(IScriptPropertyGetter p, string type, VmadValue[] items) =>
        new(type, FlagsString(p.Flags), Items: items);

    private static VmadParsedProperty ParseObject(IScriptObjectPropertyGetter p)
    {
        if (p.Object.IsNull)
            return Leaf(p, "Object", default);
        var fk = p.Object.FormKey.ToString();
        return Leaf(p, "Object", new VmadValue(FormKeyValue: fk, AliasValue: p.Alias)) with
        {
            Refs = [new VmadFormRef("", fk)],
        };
    }

    private static VmadParsedProperty ParseObjectList(IScriptObjectListPropertyGetter p)
    {
        var items = new VmadValue[p.Objects.Count];
        var refs = new List<VmadFormRef>();
        for (int i = 0; i < p.Objects.Count; i++)
        {
            if (p.Objects[i].Object.IsNull) continue;
            var fk = p.Objects[i].Object.FormKey.ToString();
            items[i] = new VmadValue(FormKeyValue: fk, AliasValue: p.Objects[i].Alias);
            refs.Add(new VmadFormRef($"[{i}]", fk));
        }

        return Array(p, "ArrayOfObject", items) with { Refs = refs };
    }

    private static VmadParsedProperty ParseStruct(IScriptStructPropertyGetter p)
    {
        var entries = new VmadStructEntry[p.Members.Count];
        for (int i = 0; i < p.Members.Count; i++)
        {
            var m = p.Members[i];
            entries[i] = new VmadStructEntry(m.Name, FlagsString(m.Flags), ToPropertyNodes(m.Properties));
        }

        return new VmadParsedProperty("Struct", FlagsString(p.Flags), StructJson: VmadJson.SerializeStruct(entries))
        {
            Refs = [.. CollectMemberRefs(p.Members.SelectMany(m => m.Properties), "")],
        };
    }

    private static VmadParsedProperty ParseStructList(IScriptStructListPropertyGetter p)
    {
        var instances = new VmadStructInstance[p.Structs.Count];
        var refs = new List<VmadFormRef>();
        for (int i = 0; i < p.Structs.Count; i++)
        {
            instances[i] = new VmadStructInstance(ToPropertyNodes(p.Structs[i].Members));
            refs.AddRange(CollectMemberRefs(p.Structs[i].Members, $"[{i}]"));
        }

        return new VmadParsedProperty(
            "ArrayOfStruct", FlagsString(p.Flags), StructJson: VmadJson.SerializeStructList(instances))
        {
            Refs = refs,
        };
    }

    // Recursively collects Object FormKeys nested in struct members so they appear in the
    // "Referenced By" tab. Paths are relative to the property being parsed.
    private static List<VmadFormRef> CollectMemberRefs(IEnumerable<IScriptPropertyGetter> members, string prefix)
    {
        var refs = new List<VmadFormRef>();
        foreach (var m in members)
        {
            var path = $@"{prefix}\{m.Name}";
            switch (m)
            {
                case IScriptObjectPropertyGetter o when !o.Object.IsNull:
                    refs.Add(new VmadFormRef(path, o.Object.FormKey.ToString()));
                    break;
                case IScriptObjectListPropertyGetter ol:
                    for (int i = 0; i < ol.Objects.Count; i++)
                    {
                        if (ol.Objects[i].Object.IsNull) continue;
                        refs.Add(new VmadFormRef($"{path}[{i}]", ol.Objects[i].Object.FormKey.ToString()));
                    }
                    break;
                case IScriptStructPropertyGetter st:
                    refs.AddRange(CollectMemberRefs(st.Members.SelectMany(w => w.Properties), path));
                    break;
                case IScriptStructListPropertyGetter sl:
                    for (int i = 0; i < sl.Structs.Count; i++)
                        refs.AddRange(CollectMemberRefs(sl.Structs[i].Members, $"{path}[{i}]"));
                    break;
            }
        }

        return refs;
    }

    private static VmadPropertyNode[] ToPropertyNodes(IReadOnlyList<IScriptPropertyGetter> properties)
    {
        var nodes = new VmadPropertyNode[properties.Count];
        for (int i = 0; i < properties.Count; i++)
            nodes[i] = ToPropertyNode(properties[i]);
        return nodes;
    }

    private static VmadPropertyNode ToPropertyNode(IScriptPropertyGetter p) => p switch
    {
        IScriptBoolPropertyGetter b => new(b.Name, "Bool", FlagsString(b.Flags), BoolValue: b.Data),
        IScriptIntPropertyGetter n => new(n.Name, "Int", FlagsString(n.Flags), IntValue: n.Data),
        IScriptFloatPropertyGetter f => new(f.Name, "Float", FlagsString(f.Flags), FloatValue: f.Data),
        IScriptStringPropertyGetter s => new(s.Name, "String", FlagsString(s.Flags), StringValue: s.Data),
        IScriptObjectPropertyGetter o => new(o.Name, "Object", FlagsString(o.Flags),
            FormKeyValue: o.Object.IsNull ? null : o.Object.FormKey.ToString(), AliasValue: o.Alias),
        IScriptStructPropertyGetter st => new(st.Name, "Struct", FlagsString(st.Flags),
            Members: [.. st.Members.SelectMany(m => m.Properties).Select(ToPropertyNode)]),
        _ => new(p.Name, p.GetType().Name, FlagsString(p.Flags))
    };

    public static string FlagsString(ScriptEntry.Flag flags) =>
        flags == ScriptEntry.Flag.InheritedAndRemoved ? "Inherited and Removed" : flags.ToString();

    public static string FlagsString(ScriptProperty.Flag flags) =>
        flags == 0 ? "" : flags.ToString();

    // A newly added property defaults to Edited (matches xEdit's add default).
    private static ScriptProperty.Flag ParseStructOpFlags(JsonElement op) =>
        op.TryGetProperty("flags", out var f) && f.GetString() is string s
            && Enum.TryParse<ScriptProperty.Flag>(s, out var parsed)
            ? parsed
            : ScriptProperty.Flag.Edited;
}
