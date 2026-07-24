using MEditService.Core.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Schema;

public class Fallout4ConditionCodecTests
{
    // ---- Envelope: operator, logic gate, run-on, float comparison ----

    [Fact]
    public void Parse_FloatComparison_ReadsEnvelope()
    {
        var condition = new ConditionFloat
        {
            CompareOperator = CompareOperator.EqualTo,
            ComparisonValue = 1.0f,
            Flags = 0,
            Data = new FunctionConditionData
            {
                Function = Condition.Function.GetIsID,
                RunOnType = Condition.RunOnType.Subject,
            },
        };

        var parsed = Fallout4ConditionCodec.Parse(condition);

        Assert.Equal("GetIsID", parsed.Function);
        Assert.Equal(ConditionOperator.EqualTo, parsed.Operator);
        Assert.False(parsed.Or);
        Assert.Equal("Subject", parsed.RunOnTarget);
        Assert.False(parsed.UseGlobal);
        Assert.Equal(1.0f, parsed.ComparisonFloat);
        Assert.Null(parsed.ComparisonGlobal);
    }

    // ---- Parameters: Mutagen's function->type table drives per-slot rendering ----

    [Fact]
    public void Parse_UsesGetParameterTypes_ForRecordAndNumberSlots()
    {
        var quest = FormKey.Factory("001234:Test.esp");
        var data = new FunctionConditionData
        {
            Function = Condition.Function.GetStageDone,   // (Quest[Form], QuestStage[Number])
            ParameterTwoNumber = 10,
        };
        data.ParameterOneRecord.SetTo(quest);

        var parsed = Fallout4ConditionCodec.Parse(new ConditionFloat { Data = data });

        Assert.Equal(2, parsed.Parameters.Count);

        Assert.Equal(ConditionParamCategory.Form, parsed.Parameters[0].Category);
        Assert.Equal("Quest", parsed.Parameters[0].TypeName);
        Assert.Equal(quest.ToString(), parsed.Parameters[0].FormKey);

        Assert.Equal(ConditionParamCategory.Number, parsed.Parameters[1].Category);
        Assert.Equal("QuestStage", parsed.Parameters[1].TypeName);
        Assert.Equal(10, parsed.Parameters[1].Number);
    }

    // A None-typed slot (function that doesn't use the parameter) yields no entry.
    [Fact]
    public void Parse_OmitsUnusedParameterSlots()
    {
        var parsed = Fallout4ConditionCodec.Parse(new ConditionFloat
        {
            Data = new FunctionConditionData { Function = Condition.Function.GetItemCount }, // (ReferencableObject, None, None)
        });

        Assert.Single(parsed.Parameters);
        Assert.Equal(ConditionParamCategory.Form, parsed.Parameters[0].Category);
    }

    [Fact]
    public void Parse_StringParameter_ReadsText()
    {
        var parsed = Fallout4ConditionCodec.Parse(new ConditionFloat
        {
            Data = new FunctionConditionData
            {
                Function = Condition.Function.GetGraphVariableFloat, // (String, None, None)
                ParameterOneString = "bLeftHandedMode",
            },
        });

        Assert.Single(parsed.Parameters);
        Assert.Equal(ConditionParamCategory.Text, parsed.Parameters[0].Category);
        Assert.Equal("bLeftHandedMode", parsed.Parameters[0].Text);
    }

    // ---- Comparison value: global vs float ----

    [Fact]
    public void Parse_UseGlobal_ReadsGlobComparison()
    {
        var glob = FormKey.Factory("00abcd:Test.esp");
        var condition = new ConditionGlobal
        {
            Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
        };
        condition.ComparisonValue.SetTo(glob);

        var parsed = Fallout4ConditionCodec.Parse(condition);

        Assert.True(parsed.UseGlobal);
        Assert.Equal(glob.ToString(), parsed.ComparisonGlobal);
        Assert.Null(parsed.ComparisonFloat);
    }

    // ---- Flags and run-on ----

    [Fact]
    public void Parse_OrFlag_DecodesLogicGate()
    {
        var parsed = Fallout4ConditionCodec.Parse(new ConditionFloat
        {
            Flags = Condition.Flag.OR,
            Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
        });

        Assert.True(parsed.Or);
    }

    [Theory]
    [InlineData(CompareOperator.NotEqualTo, ConditionOperator.NotEqualTo)]
    [InlineData(CompareOperator.GreaterThan, ConditionOperator.GreaterThan)]
    [InlineData(CompareOperator.LessThanOrEqualTo, ConditionOperator.LessThanOrEqualTo)]
    public void Parse_MapsCompareOperator(CompareOperator mutagen, ConditionOperator expected)
    {
        var parsed = Fallout4ConditionCodec.Parse(new ConditionFloat
        {
            CompareOperator = mutagen,
            Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
        });

        Assert.Equal(expected, parsed.Operator);
    }

    [Fact]
    public void Parse_RunOnReference_ResolvesTargetAndReference()
    {
        var reference = FormKey.Factory("00dcba:Test.esp");
        var data = new FunctionConditionData
        {
            Function = Condition.Function.GetIsID,
            RunOnType = Condition.RunOnType.Reference,
        };
        data.Reference.SetTo(reference);

        var parsed = Fallout4ConditionCodec.Parse(new ConditionFloat { Data = data });

        Assert.Equal("Reference", parsed.RunOnTarget);
        Assert.Equal(reference.ToString(), parsed.RunOnReference);
    }
}
