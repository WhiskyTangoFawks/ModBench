using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Tests.Query;

public class ConditionConflictClassifierTests
{
    private static ParsedCondition Condition(string function, float comparison = 1.0f) =>
        new(function, ConditionOperator.EqualTo, Or: false, "Subject", RunOnReference: null,
            UseGlobal: false, ComparisonFloat: comparison, ComparisonGlobal: null, Parameters: []);

    private static ConditionPluginInput Input(string plugin, int lo, params ParsedCondition[] conditions) =>
        new(plugin, lo, conditions.Length == 0 ? [] : [new ConditionOwner("Conditions", conditions)]);

    [Fact]
    public void Classify_IdenticalAcrossPlugins_NoConflict_IdenticalToMaster()
    {
        var result = ConditionConflictClassifier.Classify([
            Input("Master.esp", 0, Condition("GetIsID")),
            Input("Override.esp", 1, Condition("GetIsID")),
        ]);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.Equal("Override.esp", diff.WinnerPlugin);
        Assert.Equal(ConflictThis.IdenticalToMaster, diff.CellStates["Override.esp"]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictContribution);
        Assert.DoesNotContain("Master.esp", diff.CellStates.Keys); // master omitted from cell states
    }

    [Fact]
    public void Classify_OverrideDiffersFromMaster_IsOverride()
    {
        var result = ConditionConflictClassifier.Classify([
            Input("Master.esp", 0, Condition("GetIsID", 1.0f)),
            Input("Override.esp", 1, Condition("GetIsID", 2.0f)),
        ]);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.Equal(ConflictThis.Override, diff.CellStates["Override.esp"]);
        Assert.Equal(ConflictAll.Override, result.ConflictContribution);
    }

    // #267 / ADR-0035: a non-participating plugin's conditions are excluded before classification —
    // a differing condition between an enabled master and a disabled override is not a conflict.
    [Fact]
    public void Classify_DisabledPluginDiffers_ExcludedFromClassification_ReturnsNoConflict()
    {
        var participation = new Dictionary<string, bool> { ["Master.esp"] = true, ["Override.esp"] = false };

        var result = ConditionConflictClassifier.Classify(
            [
                Input("Master.esp", 0, Condition("GetIsID", 1.0f)),
                Input("Override.esp", 1, Condition("GetIsID", 2.0f)),
            ],
            pluginParticipates: participation);

        Assert.Equal(ConflictAll.NoConflict, result.ConflictContribution);
        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.DoesNotContain("Override.esp", diff.CellStates.Keys);
    }

    [Fact]
    public void Classify_ContestedWinner_IsConflict()
    {
        var result = ConditionConflictClassifier.Classify([
            Input("Master.esp", 0, Condition("GetIsID", 1.0f)),
            Input("A.esp", 1, Condition("GetIsID", 2.0f)),
            Input("B.esp", 2, Condition("GetIsID", 3.0f)),
        ]);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.Equal("B.esp", diff.WinnerPlugin);
        Assert.Equal(ConflictThis.ConflictWins, diff.CellStates["B.esp"]);
        Assert.Equal(ConflictThis.ConflictLoses, diff.CellStates["A.esp"]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictContribution);
    }

    [Fact]
    public void Classify_PerFieldStates_ColorOnlyTheFieldThatDiffers()
    {
        // Same function, different operator: only the operator field should register as a conflict.
        var master = new ParsedCondition("GetIsID", ConditionOperator.EqualTo, false, "Subject", null,
            false, 1.0f, null, []);
        var over = master with { Operator = ConditionOperator.NotEqualTo };

        var result = ConditionConflictClassifier.Classify([
            new ConditionPluginInput("Master.esp", 0, [new ConditionOwner("Conditions", [master])]),
            new ConditionPluginInput("Override.esp", 1, [new ConditionOwner("Conditions", [over])]),
        ]);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.Equal(ConflictThis.Override, diff.FieldCellStates["operator"]["Override.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, diff.FieldCellStates["function"]["Override.esp"]);
    }

    [Fact]
    public void Classify_DifferingArity_AlignsByIndex()
    {
        var result = ConditionConflictClassifier.Classify([
            Input("Master.esp", 0, Condition("GetIsID")),
            Input("Override.esp", 1, Condition("GetIsID"), Condition("GetDead")),
        ]);

        var conditions = Assert.Single(result.Compare.Groups).Conditions;
        Assert.Equal(2, conditions.Count);
        Assert.Null(conditions[1].PerPlugin["Master.esp"]);       // master has no row 1
        Assert.NotNull(conditions[1].PerPlugin["Override.esp"]);
        Assert.Equal("Override.esp", conditions[1].WinnerPlugin);
    }

    // ---- Nested-group ordering and alignment (#181) ----

    // A nested group's field path composes the enclosing array's index into the string
    // ("Effects[2].Conditions") — plain lexicographic sort would put "Effects[10]..." before
    // "Effects[2]..." (the character '1' < '2'), so group order must compare that embedded index
    // numerically instead.
    [Fact]
    public void Classify_NestedGroupFieldPaths_SortNumericallyByEnclosingIndex()
    {
        var owner10 = new ConditionOwner("Effects[10].Conditions", [Condition("GetIsID")]);
        var owner2 = new ConditionOwner("Effects[2].Conditions", [Condition("GetIsID")]);
        var input = new ConditionPluginInput("Plugin.esp", 0, [owner10, owner2]);

        var result = ConditionConflictClassifier.Classify([input]);

        Assert.Equal(
            ["Effects[2].Conditions", "Effects[10].Conditions"],
            result.Compare.Groups.Select(g => g.FieldPath).ToArray());
    }

    // Same alignment-by-index behavior as the flat Classify_DifferingArity_AlignsByIndex test above,
    // but for a nested group whose composed field path only exists because one plugin's enclosing
    // array is longer than another's (e.g. an override adding a second magic effect). Confirms the
    // existing generic per-field-path grouping needs no special-casing for nesting: a plugin whose
    // Effects array is shorter simply has no owner at that composed path, so its per-plugin cell is
    // null — "no cell for that group" per #181's AC.
    [Fact]
    public void Classify_NestedGroup_ShorterEnclosingArrayHasNoCellForMissingIndex()
    {
        var masterOwner = new ConditionOwner("Effects[0].Conditions", [Condition("GetIsID")]);
        IReadOnlyList<ConditionOwner> overrideOwners = [
            new ConditionOwner("Effects[0].Conditions", [Condition("GetIsID")]),
            new ConditionOwner("Effects[1].Conditions", [Condition("GetDead")]),
        ];

        var result = ConditionConflictClassifier.Classify([
            new ConditionPluginInput("Master.esp", 0, [masterOwner]),
            new ConditionPluginInput("Override.esp", 1, overrideOwners),
        ]);

        var group1 = result.Compare.Groups.Single(g => g.FieldPath == "Effects[1].Conditions");
        var diff = Assert.Single(group1.Conditions);
        Assert.Null(diff.PerPlugin["Master.esp"]);
        Assert.NotNull(diff.PerPlugin["Override.esp"]);
        Assert.Equal("Override.esp", diff.WinnerPlugin);
    }

    // Confirmation, not a production change (#184): NaturalFieldPathComparer already splits the
    // whole path into alternating digit/non-digit runs regardless of how many bracket pairs it
    // contains, so a two-level composed path ("Effects[2].Conditions[10].Conditions") should already
    // sort its second embedded index numerically against a single-digit one at the same position,
    // with no code change needed to reach this depth.
    [Fact]
    public void Classify_TwoLevelNestedGroupFieldPaths_SortNumericallyByInnerEnclosingIndexToo()
    {
        var owner10 = new ConditionOwner("Effects[2].Conditions[10].Conditions", [Condition("GetIsID")]);
        var owner2 = new ConditionOwner("Effects[2].Conditions[2].Conditions", [Condition("GetIsID")]);
        var input = new ConditionPluginInput("Plugin.esp", 0, [owner10, owner2]);

        var result = ConditionConflictClassifier.Classify([input]);

        Assert.Equal(
            ["Effects[2].Conditions[2].Conditions", "Effects[2].Conditions[10].Conditions"],
            result.Compare.Groups.Select(g => g.FieldPath).ToArray());
    }

    // --- FieldResolutions (#166, ADR-0031's FormKeyResolution applied to condition FormKey slots) ---

    [Fact]
    public void Classify_FormParameter_PopulatesFieldResolutionForParamKey()
    {
        var param = new ParsedConditionParam(ConditionParamCategory.Form, "Quest", FormKey: "000800:Base.esp");
        var condition = new ParsedCondition("GetStageDone", ConditionOperator.EqualTo, false, "Subject", null,
            false, 1.0f, null, [param]);
        var input = new ConditionPluginInput("A.esp", 0, [new ConditionOwner("Conditions", [condition])]);

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000800:Base.esp" ? new RecordLookupEntry("quest", "SomeQuest") : null;

        var result = ConditionConflictClassifier.Classify([input], Resolve);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.NotNull(diff.FieldResolutions);
        var paramResolutions = diff.FieldResolutions!["param:0"];
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, paramResolutions["A.esp"].State);
        Assert.Equal("SomeQuest", paramResolutions["A.esp"].EditorId);
    }

    [Fact]
    public void Classify_RunOnReference_PopulatesFieldResolutionForRunOnKey()
    {
        var condition = new ParsedCondition("GetIsID", ConditionOperator.EqualTo, false, "Reference",
            "000800:Base.esp", false, 1.0f, null, []);
        var input = new ConditionPluginInput("A.esp", 0, [new ConditionOwner("Conditions", [condition])]);

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000800:Base.esp" ? new RecordLookupEntry("npc_", "SomeActor") : null;

        var result = ConditionConflictClassifier.Classify([input], Resolve);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.NotNull(diff.FieldResolutions);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, diff.FieldResolutions!["runOn"]["A.esp"].State);
        Assert.Equal("SomeActor", diff.FieldResolutions["runOn"]["A.esp"].EditorId);
    }

    // ComparisonGlobal is checked against ["glob"] (unlike RunOnReference/parameter FormKeys, which
    // have no known expected record type) — the frontend already hardcodes formKeyMeta(['glob']) for
    // this same field, so passing it through here costs nothing and buys ResolvedWrongType detection.
    [Fact]
    public void Classify_ComparisonGlobal_ResolvedWrongType_WhenTargetIsNotAGlobal()
    {
        var condition = new ParsedCondition("GetIsID", ConditionOperator.EqualTo, false, "Subject", null,
            true, null, "000800:Base.esp", []);
        var input = new ConditionPluginInput("A.esp", 0, [new ConditionOwner("Conditions", [condition])]);

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000800:Base.esp" ? new RecordLookupEntry("kywd", "NotAGlobal") : null;

        var result = ConditionConflictClassifier.Classify([input], Resolve);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.Equal(FormKeyResolutionState.ResolvedWrongType, diff.FieldResolutions!["comparison"]["A.esp"].State);
    }

    [Fact]
    public void Classify_ComparisonGlobal_ResolvedValidType_WhenTargetIsAGlobal()
    {
        var condition = new ParsedCondition("GetIsID", ConditionOperator.EqualTo, false, "Subject", null,
            true, null, "000800:Base.esp", []);
        var input = new ConditionPluginInput("A.esp", 0, [new ConditionOwner("Conditions", [condition])]);

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000800:Base.esp" ? new RecordLookupEntry("glob", "SomeGlobal") : null;

        var result = ConditionConflictClassifier.Classify([input], Resolve);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, diff.FieldResolutions!["comparison"]["A.esp"].State);
    }

    [Fact]
    public void Classify_NoResolverPassed_FieldResolutionsStayNull()
    {
        var condition = new ParsedCondition("GetIsID", ConditionOperator.EqualTo, false, "Reference",
            "000800:Base.esp", false, 1.0f, null, []);
        var input = new ConditionPluginInput("A.esp", 0, [new ConditionOwner("Conditions", [condition])]);

        var result = ConditionConflictClassifier.Classify([input]);

        var diff = Assert.Single(Assert.Single(result.Compare.Groups).Conditions);
        Assert.Null(diff.FieldResolutions);
    }
}
