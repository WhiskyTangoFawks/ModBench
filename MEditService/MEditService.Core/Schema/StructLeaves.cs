using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A Loqui sub-record as one struct, whether it is a record's own column or nested.</summary>
internal static class StructLeaves
{
    internal static SubFieldSpec? BuildStruct(
        PropertyInfo prop, Type core,
        GameReflection game, Type[] path, int depth, ILogger logger)
    {
        var sub = SubFieldReflection.BuildSubSchema(core, game, logger, path, depth);
        if (sub.Count == 0) return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "empty struct");
        return new(prop.Name, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            SubFields: sub,
            LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }
}
