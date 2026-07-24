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
}
