using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class NullableSchemaMemberTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static bool IsAFormLinkArray(FieldMetadata field) => field is { Type: "array", ElementType.Type: "formKey" };

    [Theory]
    [InlineData("cont", "Destructible", true)]
    [InlineData("cont", "ObjectBounds", false)]
    [InlineData("npc_", "Name", true)]
    [InlineData("npc_", "HeightMin", false)]
    public void AMember_SaysWhetherAbsenceIsAValue_BecauseOnlyTheGettersOwnAnnotationSaysSinceTheClrTypeIsAReferenceTypeEitherWayForAStructAndCarriesNoDefaultForAString(string table, string column, bool allowsNull)
    {
        Assert.Equal(allowsNull, Schemas[table].RecordColumns.Single(c => c.Name == column).Field.AllowsNull);
    }

    [Fact]
    public void EveryFormLinkArrayElement_AllowsNull_HoweverDeepTheWalkReachedIt_BecauseANullSlotIsAToleratedPlaceholderNotADanglingReference()
    {
        var columns = SchemaFields.Columns(GameRelease.Fallout4).Where(column => IsAFormLinkArray(column.Field)).Select(column => column.Path).ToHashSet(StringComparer.Ordinal);
        var arrays = SchemaFields.All(GameRelease.Fallout4).Where(found => IsAFormLinkArray(found.Field)).ToList();

        Assert.NotEmpty(columns);
        Assert.Contains(arrays, found => !columns.Contains(found.Path));
        Assert.Empty(arrays.Where(found => found.Field.ElementType?.AllowsNull != true).Select(found => found.Path));
    }
}
