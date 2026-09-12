using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Codec.Schema;

/// <summary>An <c>IReadOnlyList</c> member as one array: its element's shape, and the key members
/// where the annotation tables key it.</summary>
internal static class ListLeaves
{
    /// <summary>The one element builder, whether the list is a record's own column or nested. An
    /// element has no name of its own — its members and the class it is are what identify it.</summary>
    internal static SubFieldSpec? BuildElementSpec(Type elementType, GameReflection game, Type[] path, ILogger logger)
    {
        if (ReflectedTypes.IsLoquiInterface(elementType))
        {
            // A shape with no members is not one the walk can present, and is left out of the array.
            var members = SubFieldReflection.BuildSubSchema(elementType, game, logger, path);
            return members.Count == 0
                ? null
                : new("", "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, SubFields: members,
                    LeafTypeName: ReflectedTypes.LeafTypeName(elementType));
        }

        // No owning member, so no declared default and no permitted-null annotation to ask about.
        if (LeafClassification.ClassifyLeaf(null, elementType, game) is not { } leaf) return null;

        // A form-link element is commonly sparse: a "Null" slot is a tolerated placeholder, not a
        // data error, which the element type cannot say on its own.
        return new("", leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumMembers,
            AllowsNull: leaf.ApiType == "formKey", Default: leaf.Default);
    }

    internal static SubFieldSpec? BuildList(
        PropertyInfo prop, Type elementType,
        GameReflection game, Type[] path, ILogger logger)
    {
        if (BuildElementSpec(elementType, game, path, logger) is not { } elementSpec)
            return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, elementType, "list element");

        return new(prop.Name, "array", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            ElementSpec: elementSpec,
            KeyMembers: game.Annotations.KeyMembersFor(prop));
    }
}
