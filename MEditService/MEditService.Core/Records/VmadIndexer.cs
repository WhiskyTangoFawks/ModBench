using DuckDB.NET.Data;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Core.Records;

internal sealed class VmadIndexer(
    DuckDBAppender scripts,
    DuckDBAppender props,
    DuckDBAppender items,
    List<FormRef> refs,
    ILogger logger)
{
    // Groups the 5 repeated identity fields shared by both vmad_properties and vmad_property_list_items rows.
    private readonly record struct PropContext(
        string FormKey, string Plugin, string RecordType, string ScriptName, int PropIndex);

    private readonly record struct VmadValue(
        bool? Bool = null,
        int? Int = null,
        float? Float = null,
        string? String = null,
        string? FormKey = null,
        short? Alias = null,
        string? StructJson = null);

    public void IndexRecord(
        string formKey,
        string plugin,
        string recordType,
        IAVirtualMachineAdapterGetter vmad)
    {
        var scriptList = vmad.Scripts;
        for (int si = 0; si < scriptList.Count; si++)
        {
            var script = scriptList[si];
            AppendScript(formKey, plugin, recordType, script, si);

            var properties = script.Properties;
            for (int pi = 0; pi < properties.Count; pi++)
                AppendProperty(new PropContext(formKey, plugin, recordType, script.Name, pi), properties[pi]);
        }
    }

    private void AppendScript(
        string formKey, string plugin, string recordType,
        IScriptEntryGetter script, int scriptIndex)
    {
        var row = scripts.CreateRow();
        row.AppendValue(formKey);
        row.AppendValue(plugin);
        row.AppendValue(script.Name);
        row.AppendValue((int?)scriptIndex);
        row.AppendValue(FlagsString(script.Flags));
        row.AppendValue(recordType);
        row.EndRow();
    }

    private void AppendProperty(PropContext ctx, IScriptPropertyGetter property)
    {
        switch (property)
        {
            case IScriptBoolPropertyGetter p:
                AppendPropRow(ctx, p, "Bool", new VmadValue(Bool: p.Data));
                break;

            case IScriptIntPropertyGetter p:
                AppendPropRow(ctx, p, "Int", new VmadValue(Int: p.Data));
                break;

            case IScriptFloatPropertyGetter p:
                AppendPropRow(ctx, p, "Float", new VmadValue(Float: p.Data));
                break;

            case IScriptStringPropertyGetter p:
                AppendPropRow(ctx, p, "String", new VmadValue(String: p.Data));
                break;

            case IScriptObjectPropertyGetter p:
                {
                    if (p.Object.IsNull) { AppendPropRow(ctx, p, "Object"); break; }
                    var fk = p.Object.FormKey.ToString();
                    AppendPropRow(ctx, p, "Object", new VmadValue(FormKey: fk, Alias: p.Alias));
                    refs.Add(new FormRef(ctx.FormKey, fk,
                        $@"VMAD\{ctx.ScriptName}\{property.Name}", ctx.RecordType, null));
                    break;
                }

            case IScriptBoolListPropertyGetter p:
                AppendPropRow(ctx, p, "ArrayOfBool");
                for (int i = 0; i < p.Data.Count; i++)
                    AppendItemRow(ctx, property.Name, i, "ArrayOfBool", new VmadValue(Bool: p.Data[i]));
                break;

            case IScriptIntListPropertyGetter p:
                AppendPropRow(ctx, p, "ArrayOfInt");
                for (int i = 0; i < p.Data.Count; i++)
                    AppendItemRow(ctx, property.Name, i, "ArrayOfInt", new VmadValue(Int: p.Data[i]));
                break;

            case IScriptFloatListPropertyGetter p:
                AppendPropRow(ctx, p, "ArrayOfFloat");
                for (int i = 0; i < p.Data.Count; i++)
                    AppendItemRow(ctx, property.Name, i, "ArrayOfFloat", new VmadValue(Float: p.Data[i]));
                break;

            case IScriptStringListPropertyGetter p:
                AppendPropRow(ctx, p, "ArrayOfString");
                for (int i = 0; i < p.Data.Count; i++)
                    AppendItemRow(ctx, property.Name, i, "ArrayOfString", new VmadValue(String: p.Data[i]));
                break;

            case IScriptObjectListPropertyGetter p:
                AppendObjectListProperty(ctx, p, property.Name);
                break;

            case IScriptStructPropertyGetter p:
                AppendPropRow(ctx, p, "Struct",
                    new VmadValue(StructJson: SerializeStruct(p.Members)));
                break;

            case IScriptStructListPropertyGetter p:
                AppendPropRow(ctx, p, "ArrayOfStruct",
                    new VmadValue(StructJson: SerializeStructList(p.Structs)));
                break;

            case IScriptVariablePropertyGetter p:
                AppendPropRow(ctx, p, "Variable");
                break;

            case IScriptVariableListPropertyGetter p:
                AppendPropRow(ctx, p, "ArrayOfVariable");
                break;

            default:
                logger.LogWarning("Unknown VMAD property type {Type} on {FormKey}\\{Script}\\{Prop}",
                    property.GetType().Name, ctx.FormKey, ctx.ScriptName, property.Name);
                break;
        }
    }

    private void AppendObjectListProperty(PropContext ctx, IScriptObjectListPropertyGetter p, string propName)
    {
        AppendPropRow(ctx, p, "ArrayOfObject");
        var objects = p.Objects;
        for (int i = 0; i < objects.Count; i++)
        {
            if (objects[i].Object.IsNull) { AppendItemRow(ctx, propName, i, "ArrayOfObject"); continue; }
            var fk = objects[i].Object.FormKey.ToString();
            AppendItemRow(ctx, propName, i, "ArrayOfObject", new VmadValue(FormKey: fk, Alias: objects[i].Alias));
            refs.Add(new FormRef(ctx.FormKey, fk, $@"VMAD\{ctx.ScriptName}\{propName}[{i}]", ctx.RecordType, null));
        }
    }

    private void AppendPropRow(
        PropContext ctx, IScriptPropertyGetter property,
        string type, VmadValue value = default)
    {
        var row = props.CreateRow();
        row.AppendValue(ctx.FormKey);
        row.AppendValue(ctx.Plugin);
        row.AppendValue(ctx.ScriptName);
        row.AppendValue(property.Name);
        row.AppendValue((int?)ctx.PropIndex);
        row.AppendValue(ctx.RecordType);
        row.AppendValue(type);
        row.AppendValue(FlagsString(property.Flags));
        AppendValueColumns(row, value, includeStructJson: true);
        row.EndRow();
    }

    private void AppendItemRow(
        PropContext ctx, string propName,
        int listIndex, string type, VmadValue value = default)
    {
        var row = items.CreateRow();
        row.AppendValue(ctx.FormKey);
        row.AppendValue(ctx.Plugin);
        row.AppendValue(ctx.ScriptName);
        row.AppendValue(propName);
        row.AppendValue((int?)ctx.PropIndex);
        row.AppendValue((int?)listIndex);
        row.AppendValue(ctx.RecordType);
        row.AppendValue(type);
        AppendValueColumns(row, value, includeStructJson: false);
        row.EndRow();
    }

    private static void AppendValueColumns(IDuckDBAppenderRow row, VmadValue v, bool includeStructJson)
    {
        AppendNullable(row, v.Bool);
        AppendNullable(row, v.Int);
        AppendNullable(row, v.Float);
        AppendNullableString(row, v.String);
        AppendNullableString(row, v.FormKey);
        AppendNullable(row, v.Alias);
        if (includeStructJson)
            AppendNullableString(row, v.StructJson);
    }

    private static string SerializeStruct(IReadOnlyList<IScriptEntryGetter> members)
    {
        var entries = new VmadStructEntry[members.Count];
        for (int i = 0; i < members.Count; i++)
        {
            var m = members[i];
            entries[i] = new VmadStructEntry(m.Name, FlagsString(m.Flags), ToPropertyNodes(m.Properties));
        }
        return VmadJson.SerializeStruct(entries);
    }

    private static string SerializeStructList(IReadOnlyList<IScriptEntryStructsGetter> structs)
    {
        var instances = new VmadStructInstance[structs.Count];
        for (int i = 0; i < structs.Count; i++)
            instances[i] = new VmadStructInstance(ToPropertyNodes(structs[i].Members));
        return VmadJson.SerializeStructList(instances);
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
        IScriptObjectPropertyGetter o => new(o.Name, "Object", FlagsString(o.Flags), FormKeyValue: o.Object.FormKey.ToString(), AliasValue: o.Alias),
        _ => new(p.Name, p.GetType().Name, FlagsString(p.Flags))
    };

    private static string FlagsString(ScriptEntry.Flag flags) =>
        flags == ScriptEntry.Flag.InheritedAndRemoved ? "Inherited and Removed" : flags.ToString();

    private static string FlagsString(ScriptProperty.Flag flags) =>
        flags == 0 ? "" : flags.ToString();

    private static void AppendNullable(IDuckDBAppenderRow row, bool? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    private static void AppendNullable(IDuckDBAppenderRow row, int? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    private static void AppendNullable(IDuckDBAppenderRow row, float? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    private static void AppendNullable(IDuckDBAppenderRow row, short? val)
    {
        if (val.HasValue) row.AppendValue(val.Value); else row.AppendNullValue();
    }

    private static void AppendNullableString(IDuckDBAppenderRow row, string? val)
    {
        if (val != null) row.AppendValue(val); else row.AppendNullValue();
    }
}
