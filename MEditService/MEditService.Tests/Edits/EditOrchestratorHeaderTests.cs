using System.Globalization;
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

/// <summary>
/// Header editing via pending changes (issue #85): author + ESL/ESM flag edits stage like any
/// record edit, with stage-time ESL-eligibility validation.
/// </summary>
public sealed class EditOrchestratorHeaderTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static string FlagBits(Fallout4ModHeader.HeaderFlag flags) =>
        ((long)flags).ToString(CultureInfo.InvariantCulture);

    private static (EditOrchestrator orchestrator, SessionManager manager) MakeOrchestrator()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager);
    }

    private static string HeaderKey(string plugin) => $"000000:{plugin}";

    // --- Slice 5: author on an editable header stages ---

    [Fact]
    public void StageEdit_HeaderAuthor_StagesChange()
    {
        var data = new PluginFixtureBuilder("eo-header-author")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["author"] = J("\"Jane Modder\"") };

                var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Equal("author", Assert.Single(staged.Changes).FieldPath);
                Assert.Equal("header", staged.Changes[0].RecordType);
            }
        }
    }

    // Slice 6 (header on immutable plugin → PluginImmutable) lives in EditOrchestratorTests, next to
    // the shared StubSessionManagerWithImmutablePlugin it needs.

    // --- Slice 7: ESL toggle on an eligible plugin stages ---

    [Fact]
    public void StageEdit_ToggleEsl_AllFormIdsInRange_Stages()
    {
        // Records native to the plugin land in the compact range (< 0x1000).
        var data = new PluginFixtureBuilder("eo-header-esl-ok")
            .WithPlugin("Light.esp", mod => mod.Npcs.AddNew("EslOkNpc"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Light.esp"), "Light.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Equal("flags", staged.Changes[0].FieldPath);
            }
        }
    }

    // --- Slice 7b: a record at the exact upper ESL boundary (0xFFF) stays eligible ---

    [Fact]
    public void StageEdit_ToggleEsl_FormIdAtUpperBoundary_Stages()
    {
        var data = new PluginFixtureBuilder("eo-header-esl-boundary")
            .WithPlugin("Edge.esp", mod =>
                mod.Npcs.Add(new Npc(FormKey.Factory("000FFF:Edge.esp"), Fallout4Release.Fallout4) { EditorID = "HighBound" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Edge.esp"), "Edge.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Slice 7c: an override of a master's out-of-range record does not count against ESL
    // eligibility — only records native to the plugin (ModKey == plugin) are considered. ---

    [Fact]
    public void StageEdit_ToggleEsl_OverrideOfHighIdMaster_Stages()
    {
        var masterNpc = FormKey.Factory("005000:Base.esm"); // 0x5000 > 0xFFF, but native to Base.esm
        var data = new PluginFixtureBuilder("eo-header-esl-override")
            .WithPlugin("Base.esm", mod =>
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpc" }))
            .WithPlugin("Patch.esp", mod =>
            {
                mod.Npcs.AddNew("PatchNativeNpc"); // native (~0x800), within ESL range
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpcOverride" });
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Patch.esp"), "Patch.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Slice 8: ESL toggle on an ineligible plugin is rejected, naming the offenders ---

    [Fact]
    public void StageEdit_ToggleEsl_FormIdOutOfRange_ReturnsEslIneligible()
    {
        var outOfRange = FormKey.Factory("001000:Heavy.esp"); // 0x1000 > 0xFFF → outside ESL range
        var data = new PluginFixtureBuilder("eo-header-esl-bad")
            .WithPlugin("Heavy.esp", mod =>
                mod.Npcs.Add(new Npc(outOfRange, Fallout4Release.Fallout4) { EditorID = "HeavyNpc" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Heavy.esp"), "Heavy.esp", fields, "user", null);

                var esl = Assert.IsType<StageEditResult.EslIneligible>(result);
                Assert.Equal("Heavy.esp", esl.Plugin);
                Assert.Contains(outOfRange.ToString(), esl.FormKeys);
            }
        }
    }

    // --- Slice 9: ESM toggle is never ESL-validated, even on an ineligible plugin ---

    [Fact]
    public void StageEdit_ToggleEsmOnly_IneligiblePlugin_Stages()
    {
        // Ineligible plugin (a native FormID above the ESL range) — an ESM-only toggle must still
        // stage, proving ESL eligibility is not consulted unless the ESL bit is being turned on.
        var data = new PluginFixtureBuilder("eo-header-esm-only")
            .WithPlugin("Heavy.esp", mod =>
                mod.Npcs.Add(new Npc(FormKey.Factory("001000:Heavy.esp"), Fallout4Release.Fallout4) { EditorID = "HeavyNpc" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Master)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Heavy.esp"), "Heavy.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }
}
