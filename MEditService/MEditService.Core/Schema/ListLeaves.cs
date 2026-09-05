using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>An <c>IReadOnlyList</c> field as one array column or a nested member: its element's
/// shape, and the key members where the annotation tables key it.</summary>
internal static class ListLeaves
{
    // An element has no name of its own — its members and the class it is are what identify it.
    private static SubFieldSpec? BuildListElementSpec(Type elementType, GameReflection game, Type[] path, ILogger logger)
    {
        if (ReflectedTypes.IsFormLink(elementType))
        {
            return new("", "formKey", LeafClassification.GetFormLinkValidTypes(elementType, game), LeafSpec.NoEnumMembers,
                AllowsNull: true);
        }
        if (ReflectedTypes.IsLoquiInterface(elementType))
        {
            var members = SubFieldReflection.BuildSubSchema(elementType, game, logger, path);
            return members.Count == 0
                ? null
                : new("", "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, SubFields: members,
                    LeafTypeName: ReflectedTypes.LeafTypeName(elementType));
        }
        if (ReflectedTypes.IsVectorStructType(elementType))
            return new("", "vector", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);
        if (ByteSliceHex.IsByteSlice(elementType))
            return new("", ByteSliceHex.HexApiType, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);
        return LeafClassification.TryMapPrimitive(elementType, out _, out var elemApiType)
            ? new("", elemApiType, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers)
            : null;
    }

    internal static SubFieldSpec? BuildListSubField(
        PropertyInfo prop, Type elementType,
        GameReflection game, Type[] path, ILogger logger)
    {
        var elementSpec = BuildListElementSpec(elementType, game, path, logger);
        if (elementSpec == null)
            return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, elementType, "nested list element");

        return new(prop.Name, "array", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            ElementSpec: elementSpec,
            KeyMembers: game.Annotations.KeyMembersFor(prop));
    }

    internal static ColumnInfoResult? BuildListColumn(
        PropertyInfo prop, Type elementType, GameReflection game, ILogger logger)
    {
        var elemMeta = SubFieldReflection.BuildElementMeta(elementType, game, SubFieldReflection.RootPath, logger);
        if (elemMeta == null) return SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, elementType, "list element");

        return new("VARCHAR", "array", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            ElementMeta: elemMeta, KeyMembers: game.Annotations.KeyMembersFor(prop));
    }
}
