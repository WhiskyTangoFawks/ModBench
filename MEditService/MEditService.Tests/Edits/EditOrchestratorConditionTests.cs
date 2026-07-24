using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

public sealed class EditOrchestratorConditionTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestrator()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager, changes);
    }

    private static (FormKey cobjFk, PluginFixtureData data) BuildFixture(string prefix, out string dataFolder, out string pluginsTxt)
    {
        FormKey cobjFk = default;
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjFk = cobj.FormKey;
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
            })
            .Build();
        dataFolder = data.DataFolder;
        pluginsTxt = data.PluginsTxtPath;
        return (cobjFk, data);
    }

    [Fact]
    public void StageEdit_ConditionOperatorEdit_StagedWithOldValueCaptured()
    {
        var (cobjFk, data) = BuildFixture("eo-cond-operator", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Conditions\0\Operator"] = J("\"GreaterThan\"")
            };

            var result = orchestrator.StageEdit(cobjFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var change = Assert.Single(staged.Changes);
            Assert.Equal(@"CTDA\Conditions\0\Operator", change.FieldPath);
            Assert.Equal(JsonValueKind.String, change.NewValue.ValueKind);
            Assert.Equal("GreaterThan", change.NewValue.GetString());

            // Old value must be the in-plugin operator ("EqualTo"), not null.
            Assert.Equal(JsonValueKind.String, change.OldValue.ValueKind);
            Assert.Equal("EqualTo", change.OldValue.GetString());
        }
    }

    [Fact]
    public void StageEdit_ConditionFormParameterEdit_AddsFormReference()
    {
        FormKey cobjFk = default, questFk = default;
        using var data = new PluginFixtureBuilder("eo-cond-formparam")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var quest = mod.Quests.AddNew("TargetQuest");
                questFk = quest.FormKey;
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjFk = cobj.FormKey;
                cobj.Conditions.Add(new ConditionFloat
                {
                    Data = new FunctionConditionData { Function = Condition.Function.GetStageDone },
                });
            })
            .Build();

        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Conditions\0\Parameter\0"] = J($"\"{questFk}\"")
            };

            var result = orchestrator.StageEdit(cobjFk.ToString(), "TestPlugin.esp", fields, "user", null);

            Assert.IsType<StageEditResult.Staged>(result);
            var drained = changes.DrainForPlugin("TestPlugin.esp");
            var condRef = drained.FormRefsByFormKey[cobjFk.ToString()]
                .FirstOrDefault(r => r.FieldPath.Equals(@"CTDA\Conditions\0\Parameter\0", StringComparison.Ordinal));
            Assert.NotNull(condRef);
            Assert.Equal(questFk.ToString(), condRef.TargetFormKey);
        }
    }

    [Fact]
    public void StageEdit_MalformedConditionPath_ReturnsReadOnlyFields()
    {
        var (cobjFk, data) = BuildFixture("eo-cond-malformed", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);
            // Starts with CTDA\ but has no index/sub-field segments.
            var fields = new Dictionary<string, JsonElement> { [@"CTDA\Conditions"] = J("\"x\"") };

            var result = orchestrator.StageEdit(cobjFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var ro = Assert.IsType<StageEditResult.ReadOnlyFields>(result);
            Assert.Contains(@"CTDA\Conditions", ro.Fields);
        }
    }

    [Fact]
    public void StageEdit_ConditionUnknownIndex_StagedWithNoOldValue()
    {
        var (cobjFk, data) = BuildFixture("eo-cond-unknownindex", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Conditions\9\Operator"] = J("\"GreaterThan\"")
            };

            var result = orchestrator.StageEdit(cobjFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            Assert.Equal(JsonValueKind.Null, staged.Changes[0].OldValue.ValueKind);
        }
    }

    // ---- Whole-list restage (#153): add/remove/move stage the entire condition list as one plain
    // FieldEdit at the owning field's bare path, per ADR-0019 (array indices have no stable identity).

    [Fact]
    public void StageEdit_ConditionListRestage_StagesWholeListAsFieldEdit()
    {
        var (cobjFk, data) = BuildFixture("eo-cond-list-restage", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);
            var newList = J("""
                [
                  { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 1.0, "comparisonGlobal": null, "parameters": [] },
                  { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 2.0, "comparisonGlobal": null, "parameters": [] }
                ]
                """);
            var fields = new Dictionary<string, JsonElement> { ["Conditions"] = newList };

            var result = orchestrator.StageEdit(cobjFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var change = Assert.Single(staged.Changes);
            Assert.Equal("Conditions", change.FieldPath);
            Assert.Equal(PendingChangeConstants.FieldEditChangeType, change.ChangeType);
            Assert.Equal(2, change.NewValue.GetArrayLength());
        }
    }

    [Fact]
    public void StageEdit_ConditionListRestage_ExtractsFormParameterReferences()
    {
        FormKey cobjFk = default, questFk = default;
        using var data = new PluginFixtureBuilder("eo-cond-list-restage-formref")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var quest = mod.Quests.AddNew("TargetQuest");
                questFk = quest.FormKey;
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjFk = cobj.FormKey;
            })
            .Build();

        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var newList = J($$"""
                [
                  { "function": "GetStageDone", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 0, "comparisonGlobal": null,
                    "parameters": [ { "category": "Form", "typeName": "Quest", "formKey": "{{questFk}}", "number": null, "text": null } ] }
                ]
                """);
            var fields = new Dictionary<string, JsonElement> { ["Conditions"] = newList };

            var result = orchestrator.StageEdit(cobjFk.ToString(), "TestPlugin.esp", fields, "user", null);

            Assert.IsType<StageEditResult.Staged>(result);
            var drained = changes.DrainForPlugin("TestPlugin.esp");
            var condRef = drained.FormRefsByFormKey[cobjFk.ToString()]
                .FirstOrDefault(r => r.FieldPath.Equals("Conditions", StringComparison.Ordinal));
            Assert.NotNull(condRef);
            Assert.Equal(questFk.ToString(), condRef.TargetFormKey);
        }
    }

    // Q3: staging a whole-list restage must clear any already-outstanding per-field CTDA\ pending
    // edits for that same owning field — their index references are no longer trustworthy once the
    // list has been reordered/added-to/removed-from (ADR-0019).
    [Fact]
    public void StageEdit_ConditionListRestage_ClearsSupersededPerFieldPendingEdits()
    {
        var (cobjFk, data) = BuildFixture("eo-cond-list-restage-clears", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);

            var priorFields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Conditions\0\Operator"] = J("\"GreaterThan\"")
            };
            var priorResult = orchestrator.StageEdit(cobjFk.ToString(), "TestPlugin.esp", priorFields, "user", null);
            Assert.IsType<StageEditResult.Staged>(priorResult);
            Assert.True(changes.GetPendingFields(cobjFk.ToString(), "TestPlugin.esp")
                ?.ContainsKey(@"CTDA\Conditions\0\Operator"));

            var newList = J("""
                [
                  { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 1.0, "comparisonGlobal": null, "parameters": [] }
                ]
                """);
            var restageResult = orchestrator.StageEdit(
                cobjFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["Conditions"] = newList }, "user", null);

            Assert.IsType<StageEditResult.Staged>(restageResult);
            var pendingAfter = changes.GetPendingFields(cobjFk.ToString(), "TestPlugin.esp");
            Assert.False(pendingAfter?.ContainsKey(@"CTDA\Conditions\0\Operator") ?? false);
            Assert.True(pendingAfter?.ContainsKey("Conditions"));
        }
    }

    // #154: a record with more than one condition-owning field (Quest's DialogConditions and
    // UnusedConditions) must supersede/restage each field independently — restaging one must never
    // clear a per-field pending edit staged against the *other* field on the same record.
    [Fact]
    public void StageEdit_ConditionListRestageOnOneField_LeavesSiblingFieldPendingEditIntact()
    {
        FormKey questFk = default;
        using var data = new PluginFixtureBuilder("eo-cond-multi-list-clears")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var quest = mod.Quests.AddNew("MultiListQuest");
                questFk = quest.FormKey;
                quest.DialogConditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                quest.UnusedConditions = [
                    new ConditionFloat
                    {
                        CompareOperator = CompareOperator.LessThan,
                        Data = new FunctionConditionData { Function = Condition.Function.GetDead },
                    },
                ];
            })
            .Build();
        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var priorFields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\UnusedConditions\0\Operator"] = J("\"GreaterThan\""),
            };
            var priorResult = orchestrator.StageEdit(questFk.ToString(), "TestPlugin.esp", priorFields, "user", null);
            Assert.IsType<StageEditResult.Staged>(priorResult);

            var newDialogList = J("""
                [
                  { "function": "GetIsID", "operator": "NotEqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 5.0, "comparisonGlobal": null, "parameters": [] }
                ]
                """);
            var restageResult = orchestrator.StageEdit(
                questFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["DialogConditions"] = newDialogList }, "user", null);

            Assert.IsType<StageEditResult.Staged>(restageResult);
            var pendingAfter = changes.GetPendingFields(questFk.ToString(), "TestPlugin.esp");
            Assert.True(pendingAfter?.ContainsKey(@"CTDA\UnusedConditions\0\Operator"));
            Assert.True(pendingAfter?.ContainsKey("DialogConditions"));
        }
    }
}
