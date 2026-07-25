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

    // ---- Nested (per-array-item) condition paths (#182) ----
    // Old-value capture and form-reference extraction key off ConditionPath.TryParse's opaque
    // conditionFieldPath / the whole wire path, never off whether it contains '[' — so both already
    // work for a composed indexed path with no code change. These are the regression tests proving
    // that, now that PluginWriter.IsReadOnly stops blocking staging for a path that resolves.

    private static (FormKey ingestibleFk, PluginFixtureData data) BuildNestedFixture(
        string prefix, out string dataFolder, out string pluginsTxt)
    {
        FormKey ingestibleFk = default;
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var ingestible = mod.Ingestibles.AddNew("Chem");
                ingestibleFk = ingestible.FormKey;
                var effect = new Effect { Data = new EffectData() };
                effect.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                ingestible.Effects.Add(effect);
            })
            .Build();
        dataFolder = data.DataFolder;
        pluginsTxt = data.PluginsTxtPath;
        return (ingestibleFk, data);
    }

    [Fact]
    public void StageEdit_NestedConditionOperatorEdit_StagedWithOldValueCaptured()
    {
        var (ingestibleFk, data) = BuildNestedFixture("eo-nested-cond-operator", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Effects[0].Conditions\0\Operator"] = J("\"GreaterThan\"")
            };

            var result = orchestrator.StageEdit(ingestibleFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var change = Assert.Single(staged.Changes);
            Assert.Equal(@"CTDA\Effects[0].Conditions\0\Operator", change.FieldPath);
            Assert.Equal("GreaterThan", change.NewValue.GetString());

            // Old value must be the in-plugin operator ("EqualTo"), not null — proves
            // CaptureConditionOldValues already matches ExtractNested's composed owner FieldPath.
            Assert.Equal(JsonValueKind.String, change.OldValue.ValueKind);
            Assert.Equal("EqualTo", change.OldValue.GetString());
        }
    }

    [Fact]
    public void StageEdit_NestedConditionFormParameterEdit_AddsFormReference()
    {
        FormKey ingestibleFk = default, questFk = default;
        using var data = new PluginFixtureBuilder("eo-nested-cond-formparam")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var quest = mod.Quests.AddNew("TargetQuest");
                questFk = quest.FormKey;
                var ingestible = mod.Ingestibles.AddNew("Chem");
                ingestibleFk = ingestible.FormKey;
                var effect = new Effect { Data = new EffectData() };
                effect.Conditions.Add(new ConditionFloat
                {
                    Data = new FunctionConditionData { Function = Condition.Function.GetStageDone },
                });
                ingestible.Effects.Add(effect);
            })
            .Build();

        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Effects[0].Conditions\0\Parameter\0"] = J($"\"{questFk}\"")
            };

            var result = orchestrator.StageEdit(ingestibleFk.ToString(), "TestPlugin.esp", fields, "user", null);

            Assert.IsType<StageEditResult.Staged>(result);
            var drained = changes.DrainForPlugin("TestPlugin.esp");
            var condRef = drained.FormRefsByFormKey[ingestibleFk.ToString()]
                .FirstOrDefault(r => r.FieldPath.Equals(@"CTDA\Effects[0].Conditions\0\Parameter\0", StringComparison.Ordinal));
            Assert.NotNull(condRef);
            Assert.Equal(questFk.ToString(), condRef.TargetFormKey);
        }
    }

    // ---- #183: nested whole-list restage (own-list supersession, AC3) ----

    private static (FormKey ingestibleFk, PluginFixtureData data) BuildTwoEffectNestedFixture(
        string prefix, out string dataFolder, out string pluginsTxt)
    {
        FormKey ingestibleFk = default;
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var ingestible = mod.Ingestibles.AddNew("Chem");
                ingestibleFk = ingestible.FormKey;
                var effect0 = new Effect { Data = new EffectData() };
                effect0.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                var effect1 = new Effect { Data = new EffectData() };
                effect1.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.LessThan,
                    Data = new FunctionConditionData { Function = Condition.Function.GetDead },
                });
                ingestible.Effects.Add(effect0);
                ingestible.Effects.Add(effect1);
            })
            .Build();
        dataFolder = data.DataFolder;
        pluginsTxt = data.PluginsTxtPath;
        return (ingestibleFk, data);
    }

    // Restaging a nested list must supersede its own stale per-field CTDA\ pending edits — the
    // nested analogue of StageEdit_ConditionListRestage_ClearsSupersededPerFieldPendingEdits.
    [Fact]
    public void StageEdit_NestedConditionListRestage_ClearsOwnStalePerFieldPendingEdits()
    {
        var (ingestibleFk, data) = BuildTwoEffectNestedFixture(
            "eo-nested-list-restage-clears", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);

            var priorFields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Effects[0].Conditions\0\Operator"] = J("\"GreaterThan\"")
            };
            var priorResult = orchestrator.StageEdit(ingestibleFk.ToString(), "TestPlugin.esp", priorFields, "user", null);
            Assert.IsType<StageEditResult.Staged>(priorResult);

            var newList = J("""
                [
                  { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 1.0, "comparisonGlobal": null, "parameters": [] }
                ]
                """);
            var restageResult = orchestrator.StageEdit(
                ingestibleFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["Effects[0].Conditions"] = newList }, "user", null);

            Assert.IsType<StageEditResult.Staged>(restageResult);
            var pendingAfter = changes.GetPendingFields(ingestibleFk.ToString(), "TestPlugin.esp");
            Assert.False(pendingAfter?.ContainsKey(@"CTDA\Effects[0].Conditions\0\Operator") ?? false);
            Assert.True(pendingAfter?.ContainsKey("Effects[0].Conditions"));
        }
    }

    // Restaging one index's nested list must never touch a sibling index's own pending edits on
    // the same enclosing array — the nested analogue of
    // StageEdit_ConditionListRestageOnOneField_LeavesSiblingFieldPendingEditIntact.
    [Fact]
    public void StageEdit_NestedConditionListRestageOnOneIndex_LeavesSiblingIndexPendingEditIntact()
    {
        var (ingestibleFk, data) = BuildTwoEffectNestedFixture(
            "eo-nested-list-restage-sibling", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);

            var siblingFields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Effects[1].Conditions\0\Operator"] = J("\"GreaterThan\"")
            };
            var siblingResult = orchestrator.StageEdit(ingestibleFk.ToString(), "TestPlugin.esp", siblingFields, "user", null);
            Assert.IsType<StageEditResult.Staged>(siblingResult);

            var newList = J("""
                [
                  { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 1.0, "comparisonGlobal": null, "parameters": [] }
                ]
                """);
            var restageResult = orchestrator.StageEdit(
                ingestibleFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["Effects[0].Conditions"] = newList }, "user", null);

            Assert.IsType<StageEditResult.Staged>(restageResult);
            var pendingAfter = changes.GetPendingFields(ingestibleFk.ToString(), "TestPlugin.esp");
            Assert.True(pendingAfter?.ContainsKey(@"CTDA\Effects[1].Conditions\0\Operator"));
            Assert.True(pendingAfter?.ContainsKey("Effects[0].Conditions"));
        }
    }

    // ---- #183 AC4: ancestor-array invalidation ----
    // Restaging the enclosing array itself (the whole "Effects" list) invalidates every staged
    // condition row keyed under it — both a per-field CTDA\ nested edit and a nested list's own
    // restage — since the enclosing indices no longer hold once the array has been reordered/
    // added-to/removed-from (ADR-0019). Scoped unconditionally by field-name prefix, gated only on
    // a condition codec existing for this release — no schema lookup of whether "Effects" actually
    // has nested conditions, since the prefix match is a no-op unless matching rows exist.

    [Fact]
    public void StageEdit_AncestorArrayRestage_InvalidatesStaleNestedPerFieldPendingEdit()
    {
        var (ingestibleFk, data) = BuildNestedFixture(
            "eo-ancestor-invalidate-perfield", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);

            var nestedFields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Effects[0].Conditions\0\Operator"] = J("\"GreaterThan\"")
            };
            var nestedResult = orchestrator.StageEdit(ingestibleFk.ToString(), "TestPlugin.esp", nestedFields, "user", null);
            Assert.IsType<StageEditResult.Staged>(nestedResult);

            // "effects" is the wire/column name (SchemaReflector.ToSnakeCase of the CLR "Effects"
            // property) — the ordinary generic-array edit path this restage actually goes through,
            // distinct from the PascalCase "Effects" the nested condition composed path uses.
            var ancestorResult = orchestrator.StageEdit(
                ingestibleFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["effects"] = J("[]") }, "user", null);

            Assert.IsType<StageEditResult.Staged>(ancestorResult);
            var pendingAfter = changes.GetPendingFields(ingestibleFk.ToString(), "TestPlugin.esp");
            Assert.False(pendingAfter?.ContainsKey(@"CTDA\Effects[0].Conditions\0\Operator") ?? false);
            Assert.True(pendingAfter?.ContainsKey("effects"));
        }
    }

    [Fact]
    public void StageEdit_AncestorArrayRestage_InvalidatesStaleNestedListRestage()
    {
        var (ingestibleFk, data) = BuildNestedFixture(
            "eo-ancestor-invalidate-listrestage", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);

            var newList = J("""
                [
                  { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                    "runOnReference": null, "useGlobal": false, "comparisonFloat": 1.0, "comparisonGlobal": null, "parameters": [] }
                ]
                """);
            var nestedRestageResult = orchestrator.StageEdit(
                ingestibleFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["Effects[0].Conditions"] = newList }, "user", null);
            Assert.IsType<StageEditResult.Staged>(nestedRestageResult);

            var ancestorResult = orchestrator.StageEdit(
                ingestibleFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["effects"] = J("[]") }, "user", null);

            Assert.IsType<StageEditResult.Staged>(ancestorResult);
            var pendingAfter = changes.GetPendingFields(ingestibleFk.ToString(), "TestPlugin.esp");
            Assert.False(pendingAfter?.ContainsKey("Effects[0].Conditions") ?? false);
            Assert.True(pendingAfter?.ContainsKey("effects"));
        }
    }

    // Restaging some *other* bare field on the same record (not the enclosing array) must never
    // invalidate a nested condition group's pending rows — proves the invalidation is scoped by the
    // literal field-name prefix, not a blanket clear of every condition row on the record.
    [Fact]
    public void StageEdit_UnrelatedFieldRestage_LeavesNestedConditionPendingRowsIntact()
    {
        var (ingestibleFk, data) = BuildNestedFixture(
            "eo-ancestor-unrelated-field", out var dataFolder, out var pluginsTxt);
        using var _ = data;
        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(dataFolder, pluginsTxt, GameRelease.Fallout4);

            var nestedFields = new Dictionary<string, JsonElement>
            {
                [@"CTDA\Effects[0].Conditions\0\Operator"] = J("\"GreaterThan\"")
            };
            var nestedResult = orchestrator.StageEdit(ingestibleFk.ToString(), "TestPlugin.esp", nestedFields, "user", null);
            Assert.IsType<StageEditResult.Staged>(nestedResult);

            // "weight": an ordinary scalar field on the same record, unrelated to Effects.
            var unrelatedResult = orchestrator.StageEdit(
                ingestibleFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["weight"] = J("2.5") }, "user", null);

            Assert.IsType<StageEditResult.Staged>(unrelatedResult);
            var pendingAfter = changes.GetPendingFields(ingestibleFk.ToString(), "TestPlugin.esp");
            Assert.True(pendingAfter?.ContainsKey(@"CTDA\Effects[0].Conditions\0\Operator"));
        }
    }
}
