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
}
