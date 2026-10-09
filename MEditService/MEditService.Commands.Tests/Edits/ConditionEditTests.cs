using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class ConditionEditTests : IDisposable
{
    private readonly ConditionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingOneConditionMember_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "Conditions");
        value[0].Require()["CompareOperator"] = "LessThan";

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Cobj.ToString(), "Conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Conditions[0].CompareOperator: \"GreaterThan\" -> \"LessThan\""],
            DocumentDiffs.Of(before, _fixture.Body(_fixture.Cobj)));
    }

    [Fact]
    public void EditingParameterThree_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "Conditions");
        value[0].Require()["Data"].Require()["Unknown3"] = 7;

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Cobj.ToString(), "Conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Conditions[0].Data.Unknown3: <absent> -> 7"],
            DocumentDiffs.Of(before, _fixture.Body(_fixture.Cobj)));
    }

    [Fact]
    public void EditingTheFlagsBitmask_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "Conditions");
        value[0].Require()["Flags"] = new JsonArray("OR", "ParametersUseAliases");

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Cobj.ToString(), "Conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Conditions[0].Flags[1]: <absent> -> \"ParametersUseAliases\""],
            DocumentDiffs.Of(before, _fixture.Body(_fixture.Cobj)));
    }

    [Fact]
    public void SwitchingToUseGlobal_KeepsEveryAgreeingMemberAndReplacesTheComparisonValue()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "Conditions");
        value[0].Require()["MutagenObjectType"] = "ConditionGlobal";
        value[0].Require()["ComparisonValue"] = _fixture.Global.ToString();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Cobj.ToString(), "Conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            [
                "Conditions[0].MutagenObjectType: \"ConditionFloat\" -> \"ConditionGlobal\"",
                $"Conditions[0].ComparisonValue: 2.5 -> \"{_fixture.Global}\"",
            ],
            DocumentDiffs.Of(before, _fixture.Body(_fixture.Cobj)));
    }

    [Fact]
    public void ChangingTheFunction_ClearsTheSlotsTheNewFunctionDoesNotUse()
    {
        var slot = new[] { Member("Conditions"), At(0), Member("Data"), Member("ParameterOneString") };
        var seeded = _fixture.Service().Edit(
            _fixture.Plugin, _fixture.Cobj.ToString(), SetAt(Json("\"bAllowRotation\""), slot));
        Assert.True(seeded.Applied, seeded.Message);
        Assert.Equal(
            "bAllowRotation",
            JsonNode.Parse(_fixture.Body(_fixture.Cobj)).Require()["Conditions"].Require()[0].Require()["Data"].Require()["ParameterOneString"].Require().GetValue<string>());
        var before = _fixture.Body(_fixture.Cobj);

        var result = _fixture.Service().Edit(
            _fixture.Plugin, _fixture.Cobj.ToString(),
            SetAt(Json($"\"{nameof(Condition.Function.HasKeyword)}\""), Member("Conditions"), At(0), Member("Data"), Member("Function")));

        Assert.True(result.Applied, result.Message);
        var after = JsonNode.Parse(_fixture.Body(_fixture.Cobj)).Require()["Conditions"].Require()[0].Require()["Data"].Require();
        Assert.Null(after["ParameterOneString"]);
        Assert.Equal(nameof(Condition.Function.HasKeyword), after["Function"].Require().GetValue<string>());
        Assert.Equal(
            [
                "Conditions[0].Data.Function: \"GetStageDone\" -> \"HasKeyword\"",
                "Conditions[0].Data.ParameterOneNumber: 2049 -> <absent>",
                "Conditions[0].Data.ParameterOneString: \"bAllowRotation\" -> <absent>",
            ],
            DocumentDiffs.Of(before, _fixture.Body(_fixture.Cobj)));
    }

    [Fact]
    public void ArrayAdd_AppendsOneDefaultConditionAndLeavesTheExistingOnesAlone()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var leaf = SharedSchemaReflector.FirstArrayElementLeaf("cobj", "Conditions", "MutagenObjectType");

        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.Cobj.ToString(), AddAt(Member("Conditions")));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Cobj);
        Assert.All(DocumentDiffs.Of(before, after), d => Assert.StartsWith("Conditions[2]", d, StringComparison.Ordinal));
        var appended = JsonNode.Parse(after).Require()["Conditions"].Require().AsArray()[2].Require();
        Assert.Equal(leaf, appended["MutagenObjectType"].Require().GetValue<string>());
        Assert.Equal(
            SharedSchemaReflector.FirstArrayElementLeafSubField("cobj", "Conditions", "Data", "MutagenObjectType"),
            appended["Data"].Require()["MutagenObjectType"].Require().GetValue<string>());
    }

    [Fact]
    public void ArrayRemove_DropsTheNamedConditionAndKeepsTheOther()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var second = JsonNode.Parse(before).Require()["Conditions"].Require()[1].Require().ToJsonString();

        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.Cobj.ToString(), RemoveAt(Member("Conditions"), At(0)));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Cobj);
        Assert.Equal(second, JsonNode.Parse(after).Require()["Conditions"].Require().AsArray().Single().Require().ToJsonString());
    }

    [Fact]
    public void ArrayMoveDown_SwapsTheTwoConditionsAndChangesNothingInsideThem()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var elements = JsonNode.Parse(before).Require()["Conditions"].Require().AsArray().Select(e => e.Require().ToJsonString()).ToList();

        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.Cobj.ToString(), MoveTo(1, Member("Conditions"), At(0)));

        Assert.True(result.Applied, result.Message);
        var after = JsonNode.Parse(_fixture.Body(_fixture.Cobj)).Require()["Conditions"].Require().AsArray()
            .Select(e => e.Require().ToJsonString()).ToList();
        Assert.Equal([elements[1], elements[0]], after);
    }

    [Fact]
    public void EditingAConditionNestedInsideAPerkEffect_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Perk);
        var value = _fixture.Field(_fixture.Perk, "Effects");
        value[0].Require()["Conditions"].Require()[0].Require()["Conditions"].Require()[0].Require()["Data"].Require()["Function"] = "GetIsSex";

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Perk.ToString(), "Effects", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Effects[0].Conditions[0].Conditions[0].Data.Function: \"GetIsID\" -> \"GetIsSex\""],
            DocumentDiffs.Of(before, _fixture.Body(_fixture.Perk)));
    }

    [Fact]
    public void EditingAConditionNestedInsideAMessageButton_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Message);
        var value = _fixture.Field(_fixture.Message, "MenuButtons");
        value[0].Require()["Conditions"].Require()[0].Require()["Data"].Require()["RunOnType"] = "Target";

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Message.ToString(), "MenuButtons", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["MenuButtons[0].Conditions[0].Data.RunOnType: <absent> -> \"Target\""],
            DocumentDiffs.Of(before, _fixture.Body(_fixture.Message)));
    }

    private sealed class ConditionFixture : TestInstance
    {
        private const string PluginName = "Conditions692.esp";
        private const string Origin = "Conditions692Mod";

        public PluginAddress Plugin { get; }
        public FormKey Cobj { get; }
        public FormKey Perk { get; }
        public FormKey Message { get; }
        public FormKey Global { get; }
        public FormKey Quest { get; }

        public ConditionFixture()
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var glob = mod.Globals.AddNewFloat("Cond692Global");
            glob.Data = 1f;
            Global = glob.FormKey;
            var quest = mod.Quests.AddNew("Cond692Quest");
            Quest = quest.FormKey;

            var functionDataNotGetEventDataWhoseOverlayReadsPastTheSubrecord = new FunctionConditionData { Function = Condition.Function.GetStageDone };
            functionDataNotGetEventDataWhoseOverlayReadsPastTheSubrecord.ParameterOneRecord.SetTo(quest.FormKey);
            var secondFunctionData = new FunctionConditionData { Function = Condition.Function.GetIsSex };
            var useGlobal = new ConditionGlobal { CompareOperator = CompareOperator.NotEqualTo, Data = secondFunctionData };
            useGlobal.ComparisonValue.SetTo(glob.FormKey);

            var cobj = mod.ConstructibleObjects.AddNew("Cond692Recipe");
            cobj.Conditions.Add(new ConditionFloat
            {
                CompareOperator = CompareOperator.GreaterThan,
                ComparisonValue = 2.5f,
                Flags = Condition.Flag.OR,
                Data = functionDataNotGetEventDataWhoseOverlayReadsPastTheSubrecord,
            });
            cobj.Conditions.Add(useGlobal);
            Cobj = cobj.FormKey;

            var perk = mod.Perks.AddNew("Cond692Perk");
            var perkCondition = new PerkCondition { RunOnTabIndex = 0 };
            perkCondition.Conditions.Add(new ConditionFloat
            {
                CompareOperator = CompareOperator.EqualTo,
                ComparisonValue = 1f,
                Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
            });
            var effect = new PerkQuestEffect { Rank = 1, Priority = 2 };
            effect.Conditions.Add(perkCondition);
            perk.Effects.Add(effect);
            Perk = perk.FormKey;

            var message = mod.Messages.AddNew("Cond692Message");
            var button = new MessageButton { Text = "Press" };
            button.Conditions.Add(new ConditionFloat
            {
                CompareOperator = CompareOperator.EqualTo,
                ComparisonValue = 1f,
                Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
            });
            message.MenuButtons.Add(button);
            Message = message.FormKey;

            Plugin = Add(mod, Origin);
        }

        public TestEditor Service() => EditHandler;

        public string Body(FormKey formKey) =>
            TrackedTree.Body(ModFolderOf(Plugin), Plugin, formKey.ToString());

        public JsonArray Field(FormKey formKey, string name) =>
            JsonNode.Parse(Body(formKey)).Require().AsObject()[name].Require().AsArray();
    }
}
