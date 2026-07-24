using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Schema;

public class Fallout4ConditionCodecTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // ---- ApplyFieldValue: write-back (#152) ----

    [Fact]
    public void ApplyFieldValue_Operator_SetsCompareOperator()
    {
        var condition = new ConditionFloat
        {
            CompareOperator = CompareOperator.EqualTo,
            Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
        };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "Operator", J("\"GreaterThan\""));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(CompareOperator.GreaterThan, condition.CompareOperator);
    }

    [Fact]
    public void ApplyFieldValue_Operator_UnknownEnumName_ReturnsNotFound()
    {
        var condition = new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "Operator", J("\"NotARealOperator\""));

        Assert.Equal(ConditionApplyResult.NotFound, result);
    }

    [Fact]
    public void ApplyFieldValue_Function_ChangesFunctionAndResetsParametersToNewShape()
    {
        // Old shape: GetStageDone = (Quest[Form], QuestStage[Number]) — both slots populated.
        var quest = FormKey.Factory("001234:Test.esp");
        var data = new FunctionConditionData { Function = Condition.Function.GetStageDone, ParameterTwoNumber = 10 };
        data.ParameterOneRecord.SetTo(quest);
        var condition = new ConditionFloat { Data = data };
        IList<Condition> list = [condition];

        // New shape: GetGraphVariableFloat = (String, None, None) — neither old slot value is valid here.
        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "Function", J("\"GetGraphVariableFloat\""));

        Assert.Equal(ConditionApplyResult.Applied, result);
        var newData = Assert.IsType<FunctionConditionData>(condition.Data);
        Assert.Equal(Condition.Function.GetGraphVariableFloat, newData.Function);
        Assert.True(newData.ParameterOneRecord.FormKey.IsNull);
        Assert.Null(newData.ParameterOneString);
        Assert.Equal(0, newData.ParameterTwoNumber);
    }

    [Fact]
    public void ApplyFieldValue_UnknownIndex_ReturnsNotFound()
    {
        IList<Condition> list = [new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } }];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 5, "Operator", J("\"GreaterThan\""));

        Assert.Equal(ConditionApplyResult.NotFound, result);
    }

    // ---- Parameter slots ----

    [Fact]
    public void ApplyFieldValue_NumberParameter_WritesNumberSlot()
    {
        // GetStageDone = (Quest[Form], QuestStage[Number]) — slot 2 (index 1) is Number-typed.
        var data = new FunctionConditionData { Function = Condition.Function.GetStageDone };
        var condition = new ConditionFloat { Data = data };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, @"Parameter\1", J("42"));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(42, ((FunctionConditionData)condition.Data).ParameterTwoNumber);
    }

    [Fact]
    public void ApplyFieldValue_FormParameter_WritesRecordSlot()
    {
        // GetStageDone slot 1 (index 0) is Form-typed (Quest).
        var data = new FunctionConditionData { Function = Condition.Function.GetStageDone };
        var condition = new ConditionFloat { Data = data };
        IList<Condition> list = [condition];
        var quest = FormKey.Factory("001234:Test.esp");

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, @"Parameter\0", J($"\"{quest}\""));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(quest, ((FunctionConditionData)condition.Data).ParameterOneRecord.FormKey);
    }

    [Fact]
    public void ApplyFieldValue_StringParameter_WritesStringSlot()
    {
        // GetGraphVariableFloat = (String, None, None) — slot 1 (index 0) is String-typed.
        var data = new FunctionConditionData { Function = Condition.Function.GetGraphVariableFloat };
        var condition = new ConditionFloat { Data = data };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, @"Parameter\0", J("\"bLeftHandedMode\""));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal("bLeftHandedMode", ((FunctionConditionData)condition.Data).ParameterOneString);
    }

    [Fact]
    public void ApplyFieldValue_FormParameter_WrongValueKind_ReturnsNotFound()
    {
        var data = new FunctionConditionData { Function = Condition.Function.GetStageDone };
        var condition = new ConditionFloat { Data = data };
        IList<Condition> list = [condition];

        // Slot 0 is Form-typed — a plain number can't be a FormKey.
        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, @"Parameter\0", J("42"));

        Assert.Equal(ConditionApplyResult.NotFound, result);
    }

    // ---- Run On ----

    [Fact]
    public void ApplyFieldValue_RunOn_NonReferenceTarget_SetsRunOnType()
    {
        var condition = new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "RunOn", J("""{"target":"Target","reference":null}"""));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(Condition.RunOnType.Target, condition.Data.RunOnType);
    }

    [Fact]
    public void ApplyFieldValue_RunOn_ReferenceTarget_SetsRunOnTypeAndReference()
    {
        var condition = new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [condition];
        var reference = FormKey.Factory("00dcba:Test.esp");

        var result = Fallout4ConditionCodec.ApplyFieldValue(
            list, 0, "RunOn", J($$"""{"target":"Reference","reference":"{{reference}}"}"""));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(Condition.RunOnType.Reference, condition.Data.RunOnType);
        Assert.Equal(reference, condition.Data.Reference.FormKey);
    }

    // ---- Comparison ----

    [Fact]
    public void ApplyFieldValue_Comparison_FloatCondition_WritesComparisonValue()
    {
        var condition = new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "Comparison", J("2.5"));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(2.5f, condition.ComparisonValue);
    }

    [Fact]
    public void ApplyFieldValue_Comparison_GlobalCondition_WritesGlobalFormKey()
    {
        var glob = FormKey.Factory("00abcd:Test.esp");
        var condition = new ConditionGlobal { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "Comparison", J($"\"{glob}\""));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(glob, condition.ComparisonValue.FormKey);
    }

    [Fact]
    public void ApplyFieldValue_Comparison_FloatCondition_NonNumberValue_ReturnsNotFound()
    {
        var condition = new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "Comparison", J("\"not-a-number\""));

        Assert.Equal(ConditionApplyResult.NotFound, result);
    }

    // ---- UseGlobal toggle ----

    [Fact]
    public void ApplyFieldValue_UseGlobal_TrueOnFloatCondition_ReplacesWithGlobalConditionCarryingEnvelope()
    {
        var condition = new ConditionFloat
        {
            CompareOperator = CompareOperator.GreaterThan,
            Flags = Condition.Flag.OR,
            ComparisonValue = 5.0f,
            Data = new FunctionConditionData { Function = Condition.Function.GetIsID, RunOnType = Condition.RunOnType.Target },
        };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "UseGlobal", J("true"));

        Assert.Equal(ConditionApplyResult.Applied, result);
        var replaced = Assert.IsType<ConditionGlobal>(list[0]);
        Assert.Equal(CompareOperator.GreaterThan, replaced.CompareOperator);
        Assert.Equal(Condition.Flag.OR, replaced.Flags);
        Assert.True(replaced.ComparisonValue.FormKey.IsNull);
        Assert.Equal(Condition.Function.GetIsID, ((IFunctionConditionDataGetter)replaced.Data).Function);
        Assert.Equal(Condition.RunOnType.Target, replaced.Data.RunOnType);
    }

    [Fact]
    public void ApplyFieldValue_UseGlobal_FalseOnGlobalCondition_ReplacesWithFloatConditionCarryingEnvelope()
    {
        var condition = new ConditionGlobal
        {
            CompareOperator = CompareOperator.LessThan,
            Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
        };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "UseGlobal", J("false"));

        Assert.Equal(ConditionApplyResult.Applied, result);
        var replaced = Assert.IsType<ConditionFloat>(list[0]);
        Assert.Equal(CompareOperator.LessThan, replaced.CompareOperator);
        Assert.Equal(0f, replaced.ComparisonValue);
    }

    [Fact]
    public void ApplyFieldValue_UseGlobal_AlreadyMatchingType_IsNoOpApplied()
    {
        var condition = new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [condition];

        var result = Fallout4ConditionCodec.ApplyFieldValue(list, 0, "UseGlobal", J("false"));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Same(condition, list[0]);
    }

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

    // ---- ApplyListValue: whole-list restage write-back (#153) ----
    // The wire shape is the same ParsedCondition-derived shape ConditionDiff.PerPlugin already
    // sends the frontend (camelCase field names) — ApplyListValue and Parse are inverses.

    [Fact]
    public void ApplyListValue_ReplacesListWithMaterializedConditions()
    {
        var quest = FormKey.Factory("001234:Test.esp");
        var reference = FormKey.Factory("00dcba:Test.esp");
        var glob = FormKey.Factory("00abcd:Test.esp");
        IList<Condition> list = [new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } }];

        var newList = J($$"""
            [
              {
                "function": "GetIsID",
                "operator": "EqualTo",
                "or": false,
                "runOnTarget": "Subject",
                "runOnReference": null,
                "useGlobal": false,
                "comparisonFloat": 3.5,
                "comparisonGlobal": null,
                "parameters": []
              },
              {
                "function": "GetStageDone",
                "operator": "GreaterThan",
                "or": true,
                "runOnTarget": "Reference",
                "runOnReference": "{{reference}}",
                "useGlobal": true,
                "comparisonFloat": null,
                "comparisonGlobal": "{{glob}}",
                "parameters": [
                  { "category": "Form", "typeName": "Quest", "formKey": "{{quest}}", "number": null, "text": null },
                  { "category": "Number", "typeName": "QuestStage", "number": 10, "formKey": null, "text": null }
                ]
              }
            ]
            """);

        var result = Fallout4ConditionCodec.ApplyListValue(list, newList);

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Equal(2, list.Count);

        var first = Assert.IsType<ConditionFloat>(list[0]);
        Assert.Equal(CompareOperator.EqualTo, first.CompareOperator);
        Assert.Equal((Condition.Flag)0, first.Flags);
        Assert.Equal(3.5f, first.ComparisonValue);
        var firstData = Assert.IsType<FunctionConditionData>(first.Data);
        Assert.Equal(Condition.Function.GetIsID, firstData.Function);
        Assert.Equal(Condition.RunOnType.Subject, firstData.RunOnType);

        var second = Assert.IsType<ConditionGlobal>(list[1]);
        Assert.Equal(CompareOperator.GreaterThan, second.CompareOperator);
        Assert.Equal(Condition.Flag.OR, second.Flags);
        Assert.Equal(glob, second.ComparisonValue.FormKey);
        var secondData = Assert.IsType<FunctionConditionData>(second.Data);
        Assert.Equal(Condition.Function.GetStageDone, secondData.Function);
        Assert.Equal(Condition.RunOnType.Reference, secondData.RunOnType);
        Assert.Equal(reference, secondData.Reference.FormKey);
        Assert.Equal(quest, secondData.ParameterOneRecord.FormKey);
        Assert.Equal(10, secondData.ParameterTwoNumber);
    }

    [Fact]
    public void ApplyListValue_NotAnArray_ReturnsNotFound()
    {
        IList<Condition> list = [];

        var result = Fallout4ConditionCodec.ApplyListValue(list, J("\"not-a-list\""));

        Assert.Equal(ConditionApplyResult.NotFound, result);
    }

    [Fact]
    public void ApplyListValue_UnknownFunctionName_ReturnsNotFoundAndLeavesListUnchanged()
    {
        var original = new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } };
        IList<Condition> list = [original];

        var result = Fallout4ConditionCodec.ApplyListValue(list, J("""
            [{ "function": "NotARealFunction", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
               "runOnReference": null, "useGlobal": false, "comparisonFloat": 0, "comparisonGlobal": null, "parameters": [] }]
            """));

        Assert.Equal(ConditionApplyResult.NotFound, result);
        Assert.Same(original, Assert.Single(list));
    }

    [Fact]
    public void ApplyListValue_EmptyArray_ClearsList()
    {
        IList<Condition> list = [new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } }];

        var result = Fallout4ConditionCodec.ApplyListValue(list, J("[]"));

        Assert.Equal(ConditionApplyResult.Applied, result);
        Assert.Empty(list);
    }
}
