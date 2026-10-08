using System.Globalization;
using Loqui;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public sealed class FieldOrderSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static Dictionary<string, int> MutagensFieldIndex(Type loquiClass)
    {
        var index = loquiClass.Assembly.GetType($"{loquiClass.FullName}_FieldIndex")
            ?? throw new InvalidOperationException($"Expected Mutagen to generate {loquiClass.Name}_FieldIndex.");
        return Enum.GetNames(index).ToDictionary(n => n, n => Convert.ToInt32(Enum.Parse(index, n), CultureInfo.InvariantCulture), StringComparer.Ordinal);
    }

    private static IEnumerable<string> OutOfOrder(string where, IEnumerable<string> names, Type loquiClass)
    {
        var fieldIndex = MutagensFieldIndex(loquiClass);
        var placed = names.Where(fieldIndex.ContainsKey).ToList();
        return placed.Zip(placed.Skip(1))
            .Where(pair => fieldIndex[pair.First] > fieldIndex[pair.Second])
            .Select(pair => $"{where}: {pair.First} before {pair.Second}");
    }

    private static IEnumerable<FieldMetadata> Walk(FieldMetadata spec) =>
        new[] { spec }
            .Concat((spec.Fields ?? []).SelectMany(Walk))
            .Concat(new[] { spec.ElementType }.OfType<FieldMetadata>().SelectMany(Walk))
            .Concat((spec.Variants?.Values ?? []).SelectMany(Walk));

    [Theory]
    [InlineData("weap")]
    [InlineData("gmst")]
    public void ARecordsFirstField_IsItsEditorID_AsItsFileHoldsItAfterTheHeader(string table)
    {
        var first = Schemas[table].RecordColumns.First(c => !c.Field.IsRecordHeaderMember && !c.Field.IsDiscriminator);

        Assert.Equal("EditorID", first.Name);
    }

    [Fact]
    public void EveryRecordsFields_AreInTheOrderItsFileHoldsThem_AsMutagensFieldIndexNumbersThem()
    {
        var offenders = Schemas.Values
            .SelectMany(schema => OutOfOrder(
                schema.TableName,
                schema.RecordColumns.Where(c => !c.Field.IsRecordHeaderMember).Select(c => c.Name),
                LoquiRegistration.GetRegister(schema.RecordType).ClassType))
            .ToList();

        Assert.NotEmpty(Schemas);
        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryStructOfTheGamesOwnClasses_HoldsItsMembersInTheOrderItsFileHoldsThem_AsMutagensFieldIndexNumbersThem()
    {
        var module = typeof(Weapon).Assembly;
        var structs = Schemas.Values
            .SelectMany(schema => schema.RecordColumns.SelectMany(c => Walk(c.Field)).Select(spec => (schema.TableName, Spec: spec)))
            .Where(x => x.Spec.Fields is { Count: > 1 })
            .SelectMany(x => new[] { module.GetType($"{typeof(Weapon).Namespace}.{x.Spec.LeafTypeName}") }.OfType<Type>()
                .Select(loquiClass => (Where: $"{x.TableName} {loquiClass.Name}", Members: x.Spec.Fields ?? [], Class: loquiClass)))
            .ToList();

        var offenders = structs
            .SelectMany(x => OutOfOrder(x.Where, x.Members.Select(f => f.Name), x.Class))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        Assert.NotEmpty(structs);
        Assert.Empty(offenders);
    }
}
