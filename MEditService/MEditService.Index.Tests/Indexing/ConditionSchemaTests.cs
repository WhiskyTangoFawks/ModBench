using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Indexing;

/// <summary>Two per-game facts reflection cannot read off a property: which parameter members each
/// function uses, and that Run On's Reference target is live under only one Run On value.</summary>
public sealed class ConditionSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static FieldMetadata ConditionElement(string table = "cobj") =>
        (Schemas[table].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementSpec
            ?? throw new InvalidOperationException($"Expected '{table}.Conditions' to have an element spec."))
            .ToFieldMetadata();

    private static FieldMetadata Member(FieldMetadata owner, string name) =>
        (owner.Fields ?? throw new InvalidOperationException($"Expected fields to look up member '{name}'."))
            .Single(f => f.Name == name);

    // ── the two unions ───────────────────────────────────────────────────────

    [Fact]
    public void ConditionElement_CarriesADiscriminatorOverBothConcreteConditionClasses()
    {
        var discriminator = Member(ConditionElement(), "MutagenObjectType");

        Assert.True(discriminator.IsDiscriminator);
        Assert.Equal(
            [nameof(ConditionFloat), nameof(ConditionGlobal)],
            discriminator.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void ConditionData_CarriesADiscriminatorOverBothConcreteConditionDataClasses()
    {
        var discriminator = Member(Member(ConditionElement(), "Data"), "MutagenObjectType");

        Assert.True(discriminator.IsDiscriminator);
        Assert.Equal(
            [nameof(FunctionConditionData), nameof(GetEventData)],
            discriminator.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void ComparisonValue_IsOneMemberWithAVariantPerLeaf_FloatAndGlobalLink()
    {
        var comparison = Member(ConditionElement(), "ComparisonValue");
        var variants = comparison.Variants
            ?? throw new InvalidOperationException("Expected 'ComparisonValue' to carry per-leaf variants.");

        Assert.Equal("float", variants[nameof(ConditionFloat)].Type);
        var link = variants[nameof(ConditionGlobal)];
        Assert.Equal("formKey", link.Type);
        // Empty, meaning "any record type": the link closes over the abstract IGlobalGetter, and GLOB's
        // schema table is keyed by its four concrete sibling getters, so the base resolves to no table.
        Assert.Empty(link.ValidFormKeyTypes);
    }

    // ── the two per-game facts ───────────────────────────────────────────────

    [Theory]
    [InlineData("IsSneaking")]                                                              // no slot
    [InlineData("HasKeyword", "ParameterOneRecord")]                                      // Form
    [InlineData("GetVATSValue", "ParameterOneNumber", "ParameterTwoNumber")]            // Number, Number
    [InlineData("GetStageDone", "ParameterOneRecord", "ParameterTwoNumber")]            // Form, Number
    [InlineData("GetVMQuestVariable", "ParameterOneRecord", "ParameterTwoString")]      // Form, String
    [InlineData("GetGraphVariableFloat", "ParameterOneString")]                           // String
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

    [Fact]
    public void RunOnType_NamesTheReferenceMemberUnderExactlyTheReferenceValue()
    {
        var runOn = Member(Member(ConditionElement(), "Data"), "RunOnType");
        var siblingsInUse = runOn.SiblingsInUse;

        Assert.NotNull(siblingsInUse);
        Assert.Equal(
            runOn.EnumMembers.Select(m => m.Value).Order(StringComparer.Ordinal),
            siblingsInUse.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(["Reference"], siblingsInUse[nameof(Condition.RunOnType.Reference)]);
        Assert.All(
            siblingsInUse.Where(kv => kv.Key != nameof(Condition.RunOnType.Reference)),
            kv => Assert.Empty(kv.Value));
    }

    [Fact]
    public void AnEnumThatGovernsNothing_CarriesNoMap()
    {
        Assert.Null(Member(ConditionElement(), "CompareOperator").SiblingsInUse);
        Assert.Null(Schemas["npc_"].RecordColumns.Single(c => c.Name == "Aggression").ToFieldMetadata().SiblingsInUse);
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
        var found = new List<string>();
        Walk(Schemas[table].RecordColumns.Single(c => c.Name == column).ToFieldMetadata(), column, found);

        Assert.NotEmpty(found);
        Assert.All(found, path => Assert.EndsWith("Data.Function", path, StringComparison.Ordinal));
    }

    private static void Walk(FieldMetadata meta, string path, List<string> found)
    {
        if (meta.Name == "Function" && meta.SiblingsInUse != null) found.Add(path);
        if (meta.ElementType != null) Walk(meta.ElementType, path, found);
        foreach (var field in meta.Fields ?? [])
            Walk(field, $"{path}.{field.Name}", found);
    }
}
