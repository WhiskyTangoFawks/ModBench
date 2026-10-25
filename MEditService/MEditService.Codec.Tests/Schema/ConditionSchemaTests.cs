using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public sealed class ConditionSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static FieldMetadata ConditionElement(string table = "cobj") =>
        Schemas[table].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementType
            ?? throw new InvalidOperationException($"Expected '{table}.Conditions' to have an element type.");

    private static FieldMetadata Member(FieldMetadata owner, string name) =>
        (owner.Fields ?? throw new InvalidOperationException($"Expected fields to look up member '{name}'."))
            .Single(f => f.Name == name);

    [Theory]
    [InlineData("Conditions.[].MutagenObjectType", new[] { nameof(ConditionFloat), nameof(ConditionGlobal) })]
    [InlineData("Conditions.[].Data.MutagenObjectType", new[] { nameof(GetEventData), nameof(FunctionConditionData) })]
    public void AConditionAndItsData_EachCarryADiscriminatorOverTheirConcreteClasses(string path, string[] leaves)
    {
        var discriminator = SchemaFields.At(GameRelease.Fallout4, "cobj", path);

        Assert.True(discriminator.IsDiscriminator);
        Assert.Equal(leaves, discriminator.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void ComparisonValuesGlobalLink_NamesTheGlobTable()
    {
        var variants = Member(ConditionElement(), "ComparisonValue").Variants
            ?? throw new InvalidOperationException("Expected 'ComparisonValue' to carry per-leaf variants.");

        Assert.Equal(["glob"], variants[nameof(ConditionGlobal)].ValidFormKeyTypes);
    }

    [Theory]
    [InlineData("IsSneaking")]
    [InlineData("HasKeyword", "ParameterOneRecord")]
    [InlineData("GetVATSValue", "ParameterOneNumber", "ParameterTwoNumber")]
    [InlineData("GetStageDone", "ParameterOneRecord", "ParameterTwoNumber")]
    [InlineData("GetVMQuestVariable", "ParameterOneRecord", "ParameterTwoString")]
    [InlineData("GetGraphVariableFloat", "ParameterOneString")]
    public void ConditionFunction_NamesTheParameterMembersThatFunctionUses(string function, params string[] expected)
    {
        var slots = Member(Member(ConditionElement(), "Data"), "Function").SiblingsInUse;

        Assert.NotNull(slots);
        Assert.Equal(expected, slots[function]);
    }

    [Fact]
    public void ConditionFunction_NamesEveryFunctionTheDomainOffers()
    {
        var function = Member(Member(ConditionElement(), "Data"), "Function");
        var siblingsInUse = function.SiblingsInUse
            ?? throw new InvalidOperationException("Expected 'Function' to carry a siblings-in-use map.");

        Assert.Equal(
            function.EnumMembers.Select(m => m.Value).Order(StringComparer.Ordinal),
            siblingsInUse.Keys.Order(StringComparer.Ordinal));
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "cobj", "Conditions")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions")]
    public void RunOnType_NamesTheReferenceMemberUnderExactlyTheReferenceValue(GameRelease release, string table, string column)
    {
        var condition = SharedSchemaReflector.Instance.GetSchemas(release)[table].RecordColumns.Single(c => c.Name == column).Field.ElementType.Require();
        var runOn = Member(Member(condition, "Data"), "RunOnType");
        var siblingsInUse = runOn.SiblingsInUse;

        Assert.NotNull(siblingsInUse);
        Assert.Equal(
            runOn.EnumMembers.Select(m => m.Value).Order(StringComparer.Ordinal),
            siblingsInUse.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(["Reference"], siblingsInUse["Reference"]);
        Assert.All(siblingsInUse.Where(kv => kv.Key != "Reference"), kv => Assert.Empty(kv.Value));
    }

    [Fact]
    public void AnEnumThatGovernsNothing_CarriesNoMap()
    {
        Assert.Null(Member(ConditionElement(), "CompareOperator").SiblingsInUse);
        Assert.Null(Schemas["npc_"].RecordColumns.Single(c => c.Name == "Aggression").Field.SiblingsInUse);
    }

    [Theory]
    [InlineData("cobj", "Conditions")]
    [InlineData("qust", "DialogConditions")]
    [InlineData("qust", "UnusedConditions")]
    [InlineData("mesg", "MenuButtons")]
    [InlineData("perk", "Effects")]
    [InlineData("alch", "Effects")]
    public void EveryConditionBearingColumn_ReachesTheFunctionMemberBelowIt(string table, string column)
    {
        var found = SchemaFields.Below(column, SchemaFields.At(GameRelease.Fallout4, table, column))
            .Where(f => f.Field is { Name: "Function", SiblingsInUse: not null })
            .Select(f => f.Path)
            .ToList();

        Assert.NotEmpty(found);
        Assert.All(found, path => Assert.Matches(@"Data\.Function(<\w+>)?$", path));
    }
}
