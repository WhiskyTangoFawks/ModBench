using MEditService.Core.Queries;
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
}
