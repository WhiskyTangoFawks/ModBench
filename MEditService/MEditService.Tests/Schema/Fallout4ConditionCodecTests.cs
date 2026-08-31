using System.Collections;
using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Schema;

public class Fallout4ConditionCodecTests
{
    private static readonly Fallout4ConditionCodec Codec = new();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // ---- Extract: condition-owner discovery ----

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
    // only a single hardcoded "Conditions" property.
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

    // ---- Extract: per-array-item nested condition lists ----

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

    // ---- Extract: two levels of array-item nesting ----

    // Perk.Effects[i].Conditions[j].Conditions — the
    // middle level (APerkEffect.Conditions) is a list of PerkCondition wrappers, not itself a
    // condition list (PerkCondition doesn't implement IConditionGetter) — so this exercises a real
    // second recursion hop, not just a coincidentally-named middle field.
    [Fact]
    public void Extract_TwoLevelNesting_PerkEffectConditions_ReturnsDoublyIndexedOwner()
    {
        var perk = new Perk(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        var effect = new PerkQuestEffect();
        var perkCondition = new PerkCondition();
        perkCondition.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        effect.Conditions.Add(perkCondition);
        perk.Effects.Add(effect);

        var owners = Codec.Extract(perk).ToList();

        var owner = Assert.Single(owners);
        Assert.Equal("Effects[0].Conditions[0].Conditions", owner.FieldPath);
        Assert.Single(owner.Conditions);
    }

    // A Perk with several effects, only some carrying conditions, shows a group only for the ones
    // that do.
    [Fact]
    public void Extract_TwoLevelNesting_OnlySomeEffectsCarryConditions_ReturnsOwnersOnlyForThose()
    {
        var perk = new Perk(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        perk.Effects.Add(new PerkQuestEffect()); // no conditions at all
        var withConditions = new PerkQuestEffect();
        var perkCondition = new PerkCondition();
        perkCondition.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        withConditions.Conditions.Add(perkCondition);
        withConditions.Conditions.Add(new PerkCondition()); // a PerkCondition wrapper with an empty list
        perk.Effects.Add(withConditions);

        var owners = Codec.Extract(perk).ToList();

        var owner = Assert.Single(owners);
        Assert.Equal("Effects[1].Conditions[0].Conditions", owner.FieldPath);
    }

    [Fact]
    public void Extract_TwoLevelNesting_QuestStageLogEntryConditions_ReturnsDoublyIndexedOwner()
    {
        var quest = new Quest(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        var stage = new QuestStage();
        var logEntry = new QuestLogEntry();
        logEntry.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        stage.LogEntries.Add(logEntry);
        quest.Stages.Add(stage);

        var owners = Codec.Extract(quest).ToList();

        Assert.Contains(owners, o => o.FieldPath == "Stages[0].LogEntries[0].Conditions");
    }

    [Fact]
    public void Extract_TwoLevelNesting_QuestObjectiveTargetConditions_ReturnsDoublyIndexedOwner()
    {
        var quest = new Quest(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        var objective = new QuestObjective();
        var target = new QuestObjectiveTarget();
        target.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        objective.Targets.Add(target);
        quest.Objectives.Add(objective);

        var owners = Codec.Extract(quest).ToList();

        Assert.Contains(owners, o => o.FieldPath == "Objectives[0].Targets[0].Conditions");
    }

    [Fact]
    public void Extract_TwoLevelNesting_SceneActionStartSceneConditions_ReturnsDoublyIndexedOwner()
    {
        var scene = new Scene(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        var action = new SceneAction();
        var startScene = new StartScene { Conditions = [] };
        startScene.Conditions!.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });
        action.StartScenes.Add(startScene);
        scene.Actions.Add(action);

        var owners = Codec.Extract(scene).ToList();

        Assert.Contains(owners, o => o.FieldPath == "Actions[0].StartScenes[0].Conditions");
    }

    // ---- WalkNestedArrays: the discovery walk's recursion bound ----
    // internal (not exercised through the public Extract(IMajorRecordGetter) seam): a genuine object
    // cycle can never be built from real Mutagen types, since IsArrayOfNestableStructsProperty's
    // child-record exclusion already breaks the only realistic cycle path (a shared major-record
    // reference) before recursing. This fixture proves the depth cap itself would stop a pathological
    // graph if one ever existed, using a plain self-referential test-only type no real Mutagen record
    // could express.

    private sealed class CyclicNode
    {
        public List<CyclicNode> Children { get; } = [];
    }

    [Fact]
    public void WalkNestedArrays_SelfReferentialTypeGraph_StopsAtMaxDepthRatherThanRecursingForever()
    {
        var root = new CyclicNode();
        root.Children.Add(root); // a one-node cycle: root is its own child

        var owners = Fallout4ConditionCodec.WalkNestedArrays(root, "", depth: 0).ToList();

        // No condition lists anywhere in this graph — the assertion that matters is that this call
        // returns at all (a real cycle without the cap would recurse until a StackOverflowException).
        Assert.Empty(owners);
    }

    [Fact]
    public void WalkNestedArrays_AtOrPastMaxDepth_YieldsNothingWithoutRecursing()
    {
        var root = new CyclicNode();
        root.Children.Add(new CyclicNode());

        var owners = Fallout4ConditionCodec.WalkNestedArrays(root, "", depth: Fallout4ConditionCodec.MaxNestedDepth).ToList();

        Assert.Empty(owners);
    }

    // A malformed binary plugin's Mutagen overlay can throw mid-enumeration of an array property
    // (e.g. a PerkEntryPointAbsoluteValue with an unexpected parameter type flag) — the
    // raw Mutagen exception alone doesn't say *where* in the record's array it happened. The walk
    // must re-throw with the array property's own path and the index that failed, since that's the
    // coordinate a user needs to find the offending entry in xEdit.

    private sealed class ThrowingAtIndexList(int throwAtIndex) : IEnumerable<object>
    {
        public IEnumerator<object> GetEnumerator()
        {
            for (var i = 0; i <= throwAtIndex; i++)
            {
                if (i == throwAtIndex) throw new InvalidOperationException("malformed entry");
                yield return new object();
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class ContainerWithThrowingArray
    {
        public ThrowingAtIndexList Effects { get; } = new(throwAtIndex: 2);
    }

    [Fact]
    public void WalkNestedArrays_EnumerationThrowsPartway_WrapsWithPropertyPathAndIndex()
    {
        var root = new ContainerWithThrowingArray();

        var ex = Assert.Throws<InvalidOperationException>(() =>
            Fallout4ConditionCodec.WalkNestedArrays(root, "", depth: 0).ToList());

        Assert.Equal("Effects[2]: malformed entry", ex.Message);
    }

    // ---- IsNestedConditionListField: validation-time shape check ----
    // The Type-only twin of ExtractNested's per-instance discovery, used by PluginWriter.IsReadOnly
    // for a CTDA-prefixed indexed path. A separate method from IsConditionListField
    // so the bare-fieldpath whole-list-restage gate is never loosened
    // as a side effect of resolving indexed paths here. Takes the raw composed field path
    // directly and parses it internally (arbitrary depth), rather than pre-parsed arrayProp/
    // nestedField pieces — no production caller ever needed the parsed pieces themselves.

    [Fact]
    public void IsNestedConditionListField_ConcreteElementDeclaresConditionsDirectly_ReturnsTrue()
    {
        Assert.True(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "Effects[0].Conditions"));
    }

    [Fact]
    public void IsNestedConditionListField_UnknownArrayProperty_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "NotAnArray[0].Conditions"));
    }

    [Fact]
    public void IsNestedConditionListField_WrongNestedFieldName_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "Effects[0].NotAConditionField"));
    }

    [Fact]
    public void IsNestedConditionListField_MalformedComposedPath_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "Effects[abc].Conditions"));
    }

    [Fact]
    public void IsNestedConditionListField_FlatUnbracketedPath_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IIngestibleGetter), "Conditions"));
    }

    // Quest.Aliases[i].Conditions: IAQuestAliasGetter is a marker interface with
    // zero data properties — the direct-property check on the element type alone would say no. The
    // permissive rule must accept anyway, because a concrete subtype (e.g. QuestReferenceAlias)
    // declares Conditions. Getter-interface form (schema.RecordType, as PluginWriter.IsReadOnly
    // uses it).
    [Fact]
    public void IsNestedConditionListField_AbstractElementType_AcceptsIfAnyConcreteSubtypeDeclaresConditions_GetterForm()
    {
        Assert.True(Codec.IsNestedConditionListField(typeof(IQuestGetter), "Aliases[0].Conditions"));
    }

    // Setter-class form (record.GetType(), as RecordEditService's apply dispatch uses it) —
    // AQuestAlias (the setter-side abstract base) is just as bare as its getter-side marker
    // interface, so the same fallback must apply here too.
    [Fact]
    public void IsNestedConditionListField_AbstractElementType_AcceptsIfAnyConcreteSubtypeDeclaresConditions_SetterForm()
    {
        Assert.True(Codec.IsNestedConditionListField(typeof(Quest), "Aliases[0].Conditions"));
    }

    // ---- IsNestedConditionListField: two-level composed path ----

    // Perk.Effects[i].Conditions[j].Conditions — both
    // hops (Effects -> APerkEffect, Conditions -> PerkCondition) must resolve in order before the
    // terminal Conditions (ExtendedList<Condition>) is checked.
    [Fact]
    public void IsNestedConditionListField_TwoLevelComposedPath_ResolvesEachHopInOrder()
    {
        Assert.True(Codec.IsNestedConditionListField(typeof(IPerkGetter), "Effects[0].Conditions[0].Conditions"));
    }

    [Fact]
    public void IsNestedConditionListField_TwoLevelComposedPath_WrongMiddleHopName_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IPerkGetter), "Effects[0].NotAField[0].Conditions"));
    }

    [Fact]
    public void IsNestedConditionListField_TwoLevelComposedPath_WrongTerminalFieldName_ReturnsFalse()
    {
        Assert.False(Codec.IsNestedConditionListField(typeof(IPerkGetter), "Effects[0].Conditions[0].NotAConditionField"));
    }

    // ---- ApplyFieldValue: write-back ----

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

    // The record-level overload (fieldPath -> live property, used by RecordFieldWriter — the
    // list-level overload every other ApplyFieldValue test above exercises has no fieldPath to get
    // wrong) skips gracefully rather than crashing when fieldPath names nothing on the record.
    [Fact]
    public void ApplyFieldValue_RecordLevel_UnknownFieldPath_ReturnsNotFound()
    {
        var cobj = new ConstructibleObject(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        cobj.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });

        var result = Codec.ApplyFieldValue(cobj, "NotARealField", 0, "Operator", J("\"GreaterThan\""));

        Assert.Equal(ConditionApplyResult.NotFound, result);
    }

    // Same graceful-skip, but fieldPath names a real property that isn't a condition list at all —
    // the reflection lookup finds the member, the `is IList<Condition>` pattern match is what fails.
    [Fact]
    public void ApplyFieldValue_RecordLevel_FieldPathNotAConditionList_ReturnsNotFound()
    {
        var cobj = new ConstructibleObject(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        cobj.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });

        var result = Codec.ApplyFieldValue(cobj, "EditorID", 0, "Operator", J("\"GreaterThan\""));

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

    // ---- DecodeParamValue: enum-valued Number parameters ----
    // xEdit decodes these to member names (wbSexEnum/wbAxisEnum/etc.,
    // references/TES5Edit/Core/wbDefinitionsCommon.pas); Mutagen only exposes the raw int. Scoped to
    // the seven Number-category ParameterTypes with real static xEdit enum tables actually used by an
    // FO4 Function (Sex, Axis, CrimeType, CriticalStage, Alignment, CastingSource, WardState).
    // ActorValue is deliberately excluded: Mutagen categorizes it as Form (an AVIF FormID link),
    // not Number, in FO4 — already decoded via FormKeyCell, never reaches this method.
    [Theory]
    [InlineData("Sex", 0, "Male")]
    [InlineData("Sex", 1, "Female")]
    [InlineData("Axis", 88, "X")]
    [InlineData("Axis", 89, "Y")]
    [InlineData("Axis", 90, "Z")]
    [InlineData("CrimeType", 0, "Steal")]
    [InlineData("CrimeType", 4, "Murder")]
    [InlineData("CrimeType", -1, "None")]
    [InlineData("CriticalStage", 5, "Freeze Start")]
    [InlineData("Alignment", 3, "Very Good")]
    [InlineData("CastingSource", 2, "Voice")]
    [InlineData("WardState", 1, "Absorb")]
    public void DecodeParamValue_KnownEnumTypeAndValue_ReturnsMemberName(string typeName, int number, string expected)
    {
        Assert.Equal(expected, Codec.DecodeParamValue(typeName, number));
    }

    // A value outside the known member set for an otherwise-decodable type fails closed to null —
    // the caller falls back to showing the raw number, never a wrong or made-up name.
    [Fact]
    public void DecodeParamValue_UnknownValueForKnownType_ReturnsNull()
    {
        Assert.Null(Codec.DecodeParamValue("Sex", 99));
    }

    // A ParameterType with no static enum table (a plain number, or a type this decoder doesn't cover
    // — e.g. Integer, or ActorValue which never reaches here since it's Form-category) is untouched.
    [Theory]
    [InlineData("Integer")]
    [InlineData("ActorValue")]
    [InlineData("QuestStage")]
    public void DecodeParamValue_NonEnumType_ReturnsNull(string typeName)
    {
        Assert.Null(Codec.DecodeParamValue(typeName, 0));
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

    // ---- ApplyListValue: whole-list restage write-back ----
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
