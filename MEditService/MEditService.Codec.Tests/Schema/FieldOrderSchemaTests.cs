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

    private static Dictionary<string, int>? MutagensFieldIndexEnum(Type? loquiClass) =>
        loquiClass?.Assembly.GetType($"{loquiClass.FullName}_FieldIndex") is { IsEnum: true } index
            ? Enum.GetNames(index).ToDictionary(n => n, n => Convert.ToInt32(Enum.Parse(index, n), CultureInfo.InvariantCulture), StringComparer.Ordinal)
            : null;

    private static IEnumerable<string> OutOfOrder(string where, IEnumerable<string> names, Dictionary<string, int> fieldIndex)
    {
        var placed = names.Where(fieldIndex.ContainsKey).ToList();
        return placed.Zip(placed.Skip(1))
            .Where(pair => fieldIndex[pair.First] > fieldIndex[pair.Second])
            .Select(pair => $"{where}: {pair.First} before {pair.Second}");
    }

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
            .SelectMany(schema => MutagensFieldIndexEnum(LoquiRegistration.GetRegister(schema.RecordType).ClassType) is { } fieldIndex
                ? OutOfOrder(schema.TableName, schema.RecordColumns.Where(c => !c.Field.IsRecordHeaderMember).Select(c => c.Name), fieldIndex)
                : [])
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryStructsMembers_AreInTheOrderItsFileHoldsThem_AsMutagensFieldIndexNumbersThem()
    {
        var module = typeof(Weapon).Assembly;
        static IEnumerable<SubFieldSpec> Walk(SubFieldSpec spec) =>
            new[] { spec }
                .Concat((spec.SubFields ?? []).SelectMany(Walk))
                .Concat(spec.ElementSpec is { } element ? Walk(element) : [])
                .Concat((spec.Variants?.Values ?? []).SelectMany(Walk));

        var offenders = Schemas.Values
            .SelectMany(schema => schema.RecordColumns.SelectMany(c => Walk(c.Field)).Select(s => (schema.TableName, Spec: s)))
            .SelectMany(x => x.Spec is { SubFields: { Count: > 1 } members, LeafTypeName: { } leaf }
                && MutagensFieldIndexEnum(module.GetType($"{typeof(Weapon).Namespace}.{leaf}")) is { } fieldIndex
                    ? OutOfOrder($"{x.TableName} {leaf}", members.Select(f => f.Name), fieldIndex)
                    : [])
            .Distinct(StringComparer.Ordinal)
            .ToList();

        Assert.Empty(offenders);
    }
}
