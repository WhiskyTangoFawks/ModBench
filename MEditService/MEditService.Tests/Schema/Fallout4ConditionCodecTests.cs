using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Schema;

public class Fallout4ConditionCodecTests
{
    private static readonly Fallout4ConditionCodec Codec = new();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // ---- Extract: condition-owner discovery (#154) ----

    [Fact]
    public void Extract_RecordWithSingleConditionField_ReturnsOneOwner()
    {
        var cobj = new ConstructibleObject(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        cobj.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });

        var owners = Codec.Extract(cobj).ToList();

        var owner = Assert.Single(owners);
        Assert.Equal("Conditions", owner.FieldPath);
        Assert.Single(owner.Conditions);
    }

    // Quest has two flat, top-level condition-carrying fields (DialogConditions, UnusedConditions)
    // — Extract must discover both, each independently keyed by its own field name, rather than
    // only the single hardcoded "Conditions" property this codec used to look for.
    [Fact]
    public void Extract_RecordWithMultipleConditionFields_ReturnsOneOwnerPerField()
    {
        var quest = new Quest(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        quest.DialogConditions.Add(new ConditionFloat
        {
            CompareOperator = CompareOperator.EqualTo,
            Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
        });
        quest.UnusedConditions = [
            new ConditionFloat
            {
                CompareOperator = CompareOperator.GreaterThan,
                Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
            },
        ];

        var owners = Codec.Extract(quest).ToList();

        Assert.Equal(2, owners.Count);
        var dialog = owners.Single(o => o.FieldPath == "DialogConditions");
        var unused = owners.Single(o => o.FieldPath == "UnusedConditions");
        Assert.Equal(ConditionOperator.EqualTo, Assert.Single(dialog.Conditions).Operator);
        Assert.Equal(ConditionOperator.GreaterThan, Assert.Single(unused.Conditions).Operator);
    }

    [Fact]
    public void Extract_RecordWithNoConditions_ReturnsEmpty()
    {
        var quest = new Quest(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);

        Assert.Empty(Codec.Extract(quest));
    }

    // ---- Extract: per-array-item nested condition lists (#181) ----

    // Ingestible.Effects[i].Conditions — the simplest, most widespread one-level nesting shape
    // (also shared by Ingredient/Spell/ObjectEffect's own Effects lists). Effect is a plain Loqui
    // struct (not IMajorRecordGetter), so it's a clean positive fixture with no child-record
    // ambiguity.
    [Fact]
    public void Extract_ConditionNestedInsideArrayOfStructs_ReturnsIndexedOwner()
    {
        var ingestible = new Ingestible(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        var effect = new Effect { Data = new EffectData() };
        effect.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        ingestible.Effects.Add(effect);

        var owners = Codec.Extract(ingestible).ToList();

        var owner = Assert.Single(owners);
        Assert.Equal("Effects[0].Conditions", owner.FieldPath);
        Assert.Single(owner.Conditions);
    }

    // Message.MenuButtons[i].Conditions — a different record type and a different array/list
    // property name than Effects, proving discovery is shape-generic rather than hardcoded to
    // "Effects".
    [Fact]
    public void Extract_ConditionNestedInsideDifferentlyNamedArray_ReturnsIndexedOwnerByThatArraysName()
    {
        var message = new Message(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        var button = new MessageButton();
        button.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        message.MenuButtons.Add(button);

        var owners = Codec.Extract(message).ToList();

        var owner = Assert.Single(owners);
        Assert.Equal("MenuButtons[0].Conditions", owner.FieldPath);
    }

    // Quest.Scenes[i] — Scene is itself IMajorRecordGetter (a "child record": record enumeration
    // already flattens it into its own top-level SCEN row with its own top-level Conditions field),
    // and it genuinely does declare a Conditions property directly on itself — so a naive shape-only
    // walk would wrongly find "Scenes[0].Conditions" here. The child-record exclusion must suppress
    // it, or this list would duplicate the same conditions Scene's own top-level record row already
    // surfaces.
    [Fact]
    public void Extract_ArrayOfChildRecordType_ExcludesNestedConditions()
    {
        var quest = new Quest(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        var scene = new Scene(FormKey.Factory("005678:Test.esp"), Fallout4Release.Fallout4);
        scene.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        quest.Scenes.Add(scene);

        var owners = Codec.Extract(quest).ToList();

        Assert.DoesNotContain(owners, o => o.FieldPath.StartsWith("Scenes[", StringComparison.Ordinal));
    }

    // Asserts only Extract's own string composition at a double-digit index. Numeric group
    // ordering across single- and double-digit indices is ConditionConflictClassifier's job,
    // covered by its own tests.
    [Fact]
    public void Extract_NestedConditionsAtDoubleDigitIndex_ComposesPathWithThatIndex()
    {
        var ingestible = new Ingestible(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        for (var i = 0; i < 11; i++) ingestible.Effects.Add(new Effect { Data = new EffectData() });
        ingestible.Effects[2].Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        ingestible.Effects[10].Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });

        var owners = Codec.Extract(ingestible).ToList();

        Assert.Contains(owners, o => o.FieldPath == "Effects[2].Conditions");
        Assert.Contains(owners, o => o.FieldPath == "Effects[10].Conditions");
    }

    // ---- IsNestedConditionListField: stage-time shape check (#182) ----
    // The Type-only twin of ExtractNested's per-instance discovery, used by PluginWriter.IsReadOnly
    // for a CTDA-prefixed indexed path. A separate method from IsConditionListField (#182 seam
    // decision) so the bare-fieldpath whole-list-restage gate (#183's boundary) is never loosened
    // as a side effect of resolving indexed paths here.

    [Fact]
    public void IsNestedConditionListField_ConcreteElementDeclaresConditionsDirectly_ReturnsTrue()
    {
        Assert.True(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "Effects", "Conditions"));
    }

    [Fact]
    public void IsNestedConditionListField_UnknownArrayProperty_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "NotAnArray", "Conditions"));
    }

    [Fact]
    public void IsNestedConditionListField_WrongNestedFieldName_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "Effects", "NotAConditionField"));
    }

    // Quest.Aliases[i].Conditions (#169/#182 AC#4): IAQuestAliasGetter is a marker interface with
    // zero data properties — the direct-property check on the element type alone would say no. The
    // permissive rule must accept anyway, because a concrete subtype (e.g. QuestReferenceAlias)
    // declares Conditions. Getter-interface form (schema.RecordType, as PluginWriter.IsReadOnly
    // uses it).
    [Fact]
    public void IsNestedConditionListField_AbstractElementType_AcceptsIfAnyConcreteSubtypeDeclaresConditions_GetterForm()
    {
        Assert.True(Codec.IsNestedConditionListField(typeof(IQuestGetter), "Aliases", "Conditions"));
    }

    // Setter-class form (record.GetType(), as EditOrchestrator.TryApplyField's dispatch uses it) —
    // AQuestAlias (the setter-side abstract base) is just as bare as its getter-side marker
    // interface, so the same fallback must apply here too.
    [Fact]
    public void IsNestedConditionListField_AbstractElementType_AcceptsIfAnyConcreteSubtypeDeclaresConditions_SetterForm()
    {
        Assert.True(Codec.IsNestedConditionListField(typeof(Quest), "Aliases", "Conditions"));
    }

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
