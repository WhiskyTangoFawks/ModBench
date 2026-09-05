using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A Loqui sub-record as one struct column or one nested member.</summary>
internal static class StructLeaves
{
    internal static SubFieldSpec? BuildStructSubField(
        PropertyInfo prop, Type core,
        GameReflection game, Type[] path, int depth, ILogger logger)
    {
        var sub = SubFieldReflection.BuildSubSchema(core, game, logger, path, depth);
        if (sub.Count == 0) return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "empty nested struct");
        return new(prop.Name, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            SubFields: sub,
            LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }

    internal static ColumnInfoResult? BuildStructColumn(
        PropertyInfo prop, Type core, GameReflection game, ILogger logger)
    {
        var subFields = SubFieldReflection.BuildSubSchema(core, game, logger, SubFieldReflection.RootPath);
        if (subFields.Count == 0) return SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, core, "empty struct");

        return new("VARCHAR", "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            SubFieldMetas: subFields.ConvertAll(s => s.ToFieldMetadata()), LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }
}
