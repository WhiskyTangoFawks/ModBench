using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>Each gesture is diffed member by member (<see cref="DocumentDiff"/>): a document
/// comparison is the only thing that can make the "round-trips losslessly" claim.</summary>
public sealed class ConditionEditTests : IDisposable
{
    private readonly ConditionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ── one cell ─────────────────────────────────────────────────────────────

    [Fact]
    public void EditingOneConditionMember_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "conditions");
        value[0]!["compare_operator"] = "LessThan";

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Conditions[0].CompareOperator: \"GreaterThan\" -> \"LessThan\""],
            DocumentDiff(before, _fixture.Body(_fixture.Cobj)));
    }

    [Fact]
    public void EditingParameterThree_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "conditions");
        value[0]!["data"]!["unknown3"] = 7;

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Conditions[0].Data.Unknown3: <absent> -> 7"],
            DocumentDiff(before, _fixture.Body(_fixture.Cobj)));
    }

    [Fact]
    public void EditingTheFlagsBitmask_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "conditions");
        value[0]!["flags"] = "3";   // OR | ParametersUseAliases

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Conditions[0].Flags[1]: <absent> -> \"ParametersUseAliases\""],
            DocumentDiff(before, _fixture.Body(_fixture.Cobj)));
    }

    // ── Use Global, through the discriminator ────────────────────────────────

    [Fact]
    public void SwitchingToUseGlobal_KeepsEveryAgreeingMemberAndReplacesTheComparisonValue()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var value = _fixture.Field(_fixture.Cobj, "conditions");
        value[0]!["concrete_type"] = "ConditionGlobal";
        value[0]!["comparison_value_form_key"] = _fixture.Global.ToString();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            [
                "Conditions[0].MutagenObjectType: \"ConditionFloat\" -> \"ConditionGlobal\"",
                $"Conditions[0].ComparisonValue: 2.5 -> \"{_fixture.Global}\"",
            ],
            DocumentDiff(before, _fixture.Body(_fixture.Cobj)));
    }

    // ── the function cascade the editor posts ─────────────────────────

    [Fact]
    public void ChangingTheFunction_ClearsTheSlotsTheNewFunctionDoesNotUse()
    {
        var seed = _fixture.Field(_fixture.Cobj, "conditions");
        seed[0]!["data"]!["parameter_one_string"] = "bAllowRotation";
        var seeded = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions", Json(seed.ToJsonString()));
        Assert.True(seeded.Applied, seeded.Message);
        Assert.Equal(
            "bAllowRotation",
            JsonNode.Parse(_fixture.Body(_fixture.Cobj))!["Conditions"]![0]!["Data"]!["ParameterOneString"]!.GetValue<string>());

        var value = _fixture.Field(_fixture.Cobj, "conditions");
        var data = value[0]!["data"]!;
        // HasKeyword uses parameter_one_record alone, so every other slot is idled by the change.
        data["function"] = nameof(Condition.Function.HasKeyword);
        data["parameter_one_number"] = 0;
        data["parameter_one_string"] = null;
        data["parameter_two_record"] = null;
        data["parameter_two_number"] = 0;
        data["parameter_two_string"] = null;

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        var after = JsonNode.Parse(_fixture.Body(_fixture.Cobj))!["Conditions"]![0]!["Data"]!;
        Assert.Null(after["ParameterOneString"]);
        Assert.Equal(nameof(Condition.Function.HasKeyword), after["Function"]!.GetValue<string>());
    }

    // ── array arity and order ────────────────────────────────────────────────

    [Fact]
    public void ArrayAdd_AppendsOneDefaultConditionAndLeavesTheExistingOnesAlone()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var leaf = SharedSchemaReflector.FirstArrayElementLeaf("cobj", "conditions", "concrete_type");

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions",
            Json("""{"op": "array_add", "path": []}"""));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Cobj);
        // Nothing outside the appended element moved.
        Assert.All(DocumentDiff(before, after), d => Assert.StartsWith("Conditions[2]", d, StringComparison.Ordinal));
        var appended = JsonNode.Parse(after)!["Conditions"]!.AsArray()[2]!;
        Assert.Equal(leaf, appended["MutagenObjectType"]!.GetValue<string>());
        Assert.Equal(
            SharedSchemaReflector.FirstArrayElementLeafSubField("cobj", "conditions", "data", "concrete_type"),
            appended["Data"]!["MutagenObjectType"]!.GetValue<string>());
    }

    [Fact]
    public void ArrayRemove_DropsTheNamedConditionAndKeepsTheOther()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var second = JsonNode.Parse(before)!["Conditions"]![1]!.ToJsonString();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions",
            Json("""{"op": "array_remove", "path": [{"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Cobj);
        Assert.Equal(second, JsonNode.Parse(after)!["Conditions"]!.AsArray().Single()!.ToJsonString());
    }

    [Fact]
    public void ArrayMoveDown_SwapsTheTwoConditionsAndChangesNothingInsideThem()
    {
        var before = _fixture.Body(_fixture.Cobj);
        var elements = JsonNode.Parse(before)!["Conditions"]!.AsArray().Select(e => e!.ToJsonString()).ToList();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Cobj.ToString(), "conditions",
            Json("""{"op": "array_move_down", "path": [{"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var after = JsonNode.Parse(_fixture.Body(_fixture.Cobj))!["Conditions"]!.AsArray()
            .Select(e => e!.ToJsonString()).ToList();
        Assert.Equal([elements[1], elements[0]], after);
    }

    // ── nested conditions ────────────────────────────────────────────────────

    [Fact]
    public void EditingAConditionNestedInsideAPerkEffect_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Perk);
        var value = _fixture.Field(_fixture.Perk, "effects");
        value[0]!["conditions"]![0]!["conditions"]![0]!["data"]!["function"] = "GetIsSex";

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Perk.ToString(), "effects", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Effects[0].Conditions[0].Conditions[0].Data.Function: \"GetIsID\" -> \"GetIsSex\""],
            DocumentDiff(before, _fixture.Body(_fixture.Perk)));
    }

    [Fact]
    public void EditingAConditionNestedInsideAMessageButton_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Message);
        var value = _fixture.Field(_fixture.Message, "menu_buttons");
        value[0]!["conditions"]![0]!["data"]!["run_on_type"] = "Target";

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Message.ToString(), "menu_buttons", Json(value.ToJsonString()));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["MenuButtons[0].Conditions[0].Data.RunOnType: <absent> -> \"Target\""],
            DocumentDiff(before, _fixture.Body(_fixture.Message)));
    }

    // ── document comparison ──────────────────────────────────────────────────

    internal static List<string> DocumentDiff(string before, string after)
    {
        var diffs = new List<string>();
        Walk("", JsonNode.Parse(before), JsonNode.Parse(after), diffs);
        return diffs;
    }

    private static void Walk(string path, JsonNode? before, JsonNode? after, List<string> diffs)
    {
        if (before is JsonObject b && after is JsonObject a)
        {
            foreach (var name in b.Select(p => p.Key).Concat(a.Select(p => p.Key)).Distinct(StringComparer.Ordinal))
                Walk(path.Length == 0 ? name : $"{path}.{name}", b[name], a[name], diffs);
            return;
        }
        if (before is JsonArray ba && after is JsonArray aa)
        {
            for (var i = 0; i < Math.Max(ba.Count, aa.Count); i++)
            {
                Walk($"{path}[{i}]",
                    i < ba.Count ? ba[i] : null,
                    i < aa.Count ? aa[i] : null,
                    diffs);
            }
            return;
        }

        var left = before?.ToJsonString() ?? "<absent>";
        var right = after?.ToJsonString() ?? "<absent>";
        if (!string.Equals(left, right, StringComparison.Ordinal)) diffs.Add($"{path}: {left} -> {right}");
    }

    private sealed class ConditionFixture : IDisposable
    {
        private const string PluginName = "Conditions692.esp";
        private const string Origin = "Conditions692Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-692-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-692-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Cobj { get; }
        public FormKey Perk { get; }
        public FormKey Message { get; }
        public FormKey Global { get; }
        public FormKey Quest { get; }

        public ConditionFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var glob = mod.Globals.AddNewFloat("Cond692Global");
            glob.Data = 1f;
            Global = glob.FormKey;
            var quest = mod.Quests.AddNew("Cond692Quest");
            Quest = quest.FormKey;

            // Both leaves of the Condition union, so a whole-list resend carries both shapes of
            // ComparisonValue. Deliberately not a GetEventData: Mutagen 0.53.1's GetEventDataBinaryOverlay
            // inherits FunctionConditionData offsets, so reading Unknown3 off one runs past the subrecord.
            var functionData = new FunctionConditionData { Function = Condition.Function.GetStageDone };
            functionData.ParameterOneRecord.SetTo(quest.FormKey);
            var secondFunctionData = new FunctionConditionData { Function = Condition.Function.GetIsSex };
            var useGlobal = new ConditionGlobal { CompareOperator = CompareOperator.NotEqualTo, Data = secondFunctionData };
            useGlobal.ComparisonValue.SetTo(glob.FormKey);

            var cobj = mod.ConstructibleObjects.AddNew("Cond692Recipe");
            cobj.Conditions.Add(new ConditionFloat
            {
                CompareOperator = CompareOperator.GreaterThan,
                ComparisonValue = 2.5f,
                Flags = Condition.Flag.OR,
                Data = functionData,
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

            mod.WriteToBinary(pluginPath);

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            Assert.Empty(_mirror.LoadOrder!.Failures);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body(FormKey formKey) =>
            _mirror.Index!.At(RecordRef.Effective).GetDocument(formKey.ToString(), Plugin)!.Body!;

        public JsonArray Field(FormKey formKey, string name)
        {
            var document = _mirror.Index!.At(RecordRef.Effective).GetDocument(formKey.ToString(), Plugin)!;
            var raw = document.Fields.Single(f => f.Metadata.Name == name).Value;
            return JsonNode.Parse(raw!.ToString()!)!.AsArray();
        }

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
