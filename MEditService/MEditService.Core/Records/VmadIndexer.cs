using DuckDB.NET.Data;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Core.Records;

// Walks a record's VMAD through the codec and lays the result out as relational rows.
// The codec owns what a property type means; this owns where its parts are stored.
internal sealed class VmadIndexer(
    DuckDBAppender scripts,
    DuckDBAppender props,
    DuckDBAppender items,
    List<FormRef> refs,
    ILogger logger)
{
    // Groups the 6 repeated identity fields shared by both vmad_properties and vmad_property_list_items rows.
    private readonly record struct PropContext(
        string FormKey, string Plugin, string Origin, string RecordType, string ScriptName, int PropIndex);

    public void IndexRecord(
        string formKey,
        string plugin,
        string origin,
        string recordType,
        IAVirtualMachineAdapterGetter vmad)
    {
        var scriptList = vmad.Scripts;
        for (int si = 0; si < scriptList.Count; si++)
        {
            var script = scriptList[si];
            AppendScript(formKey, plugin, origin, recordType, script, si);

            var properties = script.Properties;
            for (int pi = 0; pi < properties.Count; pi++)
                AppendProperty(new PropContext(formKey, plugin, origin, recordType, script.Name, pi), properties[pi]);
        }
    }

    private void AppendScript(
        string formKey, string plugin, string origin, string recordType,
        IScriptEntryGetter script, int scriptIndex)
    {
        var row = scripts.CreateRow();
        row.AppendValue(formKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(script.Name);
        row.AppendValue((int?)scriptIndex);
        row.AppendValue(VmadCodec.FlagsString(script.Flags));
        row.AppendValue(recordType);
        row.EndRow();
    }

    private void AppendProperty(PropContext ctx, IScriptPropertyGetter property)
    {
        if (VmadCodec.Parse(property) is not { } parsed)
        {
            logger.LogWarning("Unknown VMAD property type {Type} on {FormKey}\\{Script}\\{Prop}",
                property.GetType().Name, ctx.FormKey, ctx.ScriptName, property.Name);
            return;
        }

        AppendPropRow(ctx, property.Name, parsed);

        for (int i = 0; parsed.Items != null && i < parsed.Items.Count; i++)
            AppendItemRow(ctx, property.Name, i, parsed.Type, parsed.Items[i]);

        var propPath = $@"VMAD\{ctx.ScriptName}\{property.Name}";
        foreach (var r in parsed.Refs)
            refs.Add(new FormRef(ctx.FormKey, r.FormKey, propPath + r.RelativePath, ctx.RecordType, null));
    }

    private void AppendPropRow(PropContext ctx, string propName, VmadParsedProperty parsed)
    {
        var row = props.CreateRow();
        row.AppendValue(ctx.FormKey);
        row.AppendValue(ctx.Plugin);
        row.AppendValue(ctx.Origin);
        row.AppendValue(ctx.ScriptName);
        row.AppendValue(propName);
        row.AppendValue((int?)ctx.PropIndex);
        row.AppendValue(ctx.RecordType);
        row.AppendValue(parsed.Type);
        row.AppendValue(parsed.Flags);
        AppendValueColumns(row, parsed.Value);
        DuckDbAppend.Nullable(row, parsed.StructJson);
        row.EndRow();
    }

    private void AppendItemRow(
        PropContext ctx, string propName,
        int listIndex, string type, VmadValue value)
    {
        var row = items.CreateRow();
        row.AppendValue(ctx.FormKey);
        row.AppendValue(ctx.Plugin);
        row.AppendValue(ctx.Origin);
        row.AppendValue(ctx.ScriptName);
        row.AppendValue(propName);
        row.AppendValue((int?)ctx.PropIndex);
        row.AppendValue((int?)listIndex);
        row.AppendValue(ctx.RecordType);
        row.AppendValue(type);
        AppendValueColumns(row, value);
        row.EndRow();
    }

    private static void AppendValueColumns(IDuckDBAppenderRow row, VmadValue v)
    {
        DuckDbAppend.Nullable(row, v.BoolValue);
        DuckDbAppend.Nullable(row, v.IntValue);
        DuckDbAppend.Nullable(row, v.FloatValue);
        DuckDbAppend.Nullable(row, v.StringValue);
        DuckDbAppend.Nullable(row, v.FormKeyValue);
        DuckDbAppend.Nullable(row, v.AliasValue);
    }
}
