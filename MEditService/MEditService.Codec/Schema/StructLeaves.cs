using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Codec.Schema;

/// <summary>A Loqui sub-record as one struct, whether it is a record's own column or nested.</summary>
internal static class StructLeaves
{
    internal static SubFieldSpec? BuildStruct(
        PropertyInfo prop, Type core,
        GameReflection game, Type[] path, ILogger logger)
    {
        var sub = SubFieldReflection.BuildSubSchema(core, game, logger, path);
        if (sub.Count == 0) return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "empty struct");
        return new(prop.Name, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            SubFields: sub,
            // Absence is the value where the getter says the sub-record may be unset; where it may
            // not, an omitted member is the codec's own default, not "no struct".
            AllowsNull: ReflectedTypes.IsNullableMember(prop),
            LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }
}
