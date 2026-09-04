using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #692: the shape a condition reaches the editor as, now that the Condition/ConditionData union
/// exclusions are lifted — an ordinary array-of-struct column, its two unions expanded by the same
/// mechanism every other Loqui union goes through, plus the two per-game facts reflection cannot
/// read off a property: which parameter members each function actually uses, and that Run On's
/// Reference target is only live under one Run On value.
/// </summary>
public sealed class ConditionSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static FieldMetadata ConditionElement(string table = "cobj") =>
        Schemas[table].RecordColumns.Single(c => c.Name == "conditions").ElementType!;

    private static FieldMetadata Member(FieldMetadata owner, string name) =>
        owner.Fields!.Single(f => f.Name == name);

    // ── the two unions ───────────────────────────────────────────────────────

    [Fact]
    public void ConditionElement_CarriesADiscriminatorOverBothConcreteConditionClasses()
    {
        var discriminator = Member(ConditionElement(), "concrete_type");

        Assert.True(discriminator.IsDiscriminator);
        Assert.Equal(
            [nameof(ConditionFloat), nameof(ConditionGlobal)],
            discriminator.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void ConditionData_CarriesADiscriminatorOverBothConcreteConditionDataClasses()
    {
        var discriminator = Member(Member(ConditionElement(), "data"), "concrete_type");

        Assert.True(discriminator.IsDiscriminator);
        Assert.Equal(
            [nameof(FunctionConditionData), nameof(GetEventData)],
            discriminator.EnumMembers.Select(m => m.Value));
    }

    /// <summary>
    /// <c>ComparisonValue</c> is a float on one leaf and a GLOB link on the other, which is the
    /// per-shape split (#701): one field per shape, each gated to the leaves that declare it, so a
    /// resend after switching leaf drops the outgoing member by name instead of failing to convert
    /// it. There is no second mechanism for a per-leaf type difference — this is it.
    /// </summary>
    [Fact]
    public void ComparisonValue_IsOneFieldPerShape_FloatAndGlobalLink()
    {
        var element = ConditionElement();

        Assert.Equal("float", Member(element, "comparison_value_float").Type);
        var link = Member(element, "comparison_value_form_key");
        Assert.Equal("formKey", link.Type);
        // Empty, meaning "any record type": the link closes over the abstract IGlobalGetter, and
        // GLOB's schema table is keyed by its four concrete sibling getters, so the base resolves to
        // no table. Every other IFormLink<IGlobalGetter> in the schema reads the same way.
        Assert.Empty(link.ValidFormKeyTypes);
        Assert.DoesNotContain(element.Fields!, f => f.Name == "comparison_value");
    }

    // ── the two per-game facts ───────────────────────────────────────────────

    /// <summary>
    /// Mutagen models each parameter slot as three members and picks one by the function's own
    /// parameter category, so a function change moves which member carries the value. The map says
    /// which, per function, and is read from <c>Condition.GetParameterTypes</c> — the same table
    /// Mutagen's own writer switches on — so it cannot drift from what actually goes to the wire.
    /// </summary>
    [Theory]
    [InlineData("IsSneaking")]                                                              // no slot
    [InlineData("HasKeyword", "parameter_one_record")]                                      // Form
    [InlineData("GetVATSValue", "parameter_one_number", "parameter_two_number")]            // Number, Number
    [InlineData("GetStageDone", "parameter_one_record", "parameter_two_number")]            // Form, Number
    [InlineData("GetVMQuestVariable", "parameter_one_record", "parameter_two_string")]      // Form, String
    [InlineData("GetGraphVariableFloat", "parameter_one_string")]                           // String
    public void ConditionFunction_NamesTheParameterMembersThatFunctionUses(string function, params string[] expected)
    {
        var slots = Member(Member(ConditionElement(), "data"), "function").SiblingsInUse;

        Assert.NotNull(slots);
        Assert.Equal(expected, slots![function]);
    }

    [Fact]
    public void ConditionFunction_NamesEveryFunctionTheDomainOffers()
    {
        var function = Member(Member(ConditionElement(), "data"), "function");

        Assert.Equal(
            function.EnumMembers.Select(m => m.Value).Order(StringComparer.Ordinal),
            function.SiblingsInUse!.Keys.Order(StringComparer.Ordinal));
    }

    /// <summary>Run On's reference target is read only under the one Run On value that names one —
    /// under every other, the member holds no data, and leaving a stale target behind would keep a
    /// master alive for a link the game never reads (masters are content-derived, ADR-0038).</summary>
    [Fact]
    public void RunOnType_NamesTheReferenceMemberUnderExactlyTheReferenceValue()
    {
        var runOn = Member(Member(ConditionElement(), "data"), "run_on_type");

        Assert.NotNull(runOn.SiblingsInUse);
        Assert.Equal(
            runOn.EnumMembers.Select(m => m.Value).Order(StringComparer.Ordinal),
            runOn.SiblingsInUse!.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(["reference"], runOn.SiblingsInUse[nameof(Condition.RunOnType.Reference)]);
        Assert.All(
            runOn.SiblingsInUse.Where(kv => kv.Key != nameof(Condition.RunOnType.Reference)),
            kv => Assert.Empty(kv.Value));
    }

    /// <summary>The overwhelming majority of enum fields govern nothing, and say so by carrying no
    /// map at all rather than an empty one — otherwise every enum on the wire would pay for a
    /// concept two members use.</summary>
    [Fact]
    public void AnEnumThatGovernsNothing_CarriesNoMap()
    {
        Assert.Null(Member(ConditionElement(), "compare_operator").SiblingsInUse);
        Assert.Null(Schemas["npc_"].RecordColumns.Single(c => c.Name == "aggression").ToFieldMetadata().SiblingsInUse);
    }

    /// <summary>Every nesting a condition list reaches in Fallout 4, each named so a walk that
    /// stopped short of one fails here rather than in the editor.</summary>
    [Theory]
    [InlineData("cobj", "conditions")]
    [InlineData("qust", "dialog_conditions")]
    [InlineData("qust", "unused_conditions")]
    [InlineData("mesg", "menu_buttons")]
    [InlineData("perk", "effects")]
    [InlineData("alch", "effects")]
    public void EveryConditionBearingColumn_ReachesTheFunctionMemberBelowIt(string table, string column)
    {
        var found = new List<string>();
        Walk(Schemas[table].RecordColumns.Single(c => c.Name == column).ToFieldMetadata(), column, found);

        Assert.NotEmpty(found);
        Assert.All(found, path => Assert.EndsWith("data.function", path, StringComparison.Ordinal));
    }

    private static void Walk(FieldMetadata meta, string path, List<string> found)
    {
        if (meta.Name == "function" && meta.SiblingsInUse != null) found.Add(path);
        if (meta.ElementType != null) Walk(meta.ElementType, path, found);
        foreach (var field in meta.Fields ?? [])
            Walk(field, $"{path}.{field.Name}", found);
    }
}
