using System.Globalization;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
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
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        // Wire `changes` into the SessionManager (not just the orchestrator) so it receives the
        // session's own DuckDB connection via IPendingChangeLifecycle — required for any orchestrator
        // path (e.g. Renumber) that queries pending_changes through IRecordRepository.GetReferences.
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector, TestRecordVendor.Create(), TestRecordReverter.Create(), NullLogger<EditOrchestrator>.Instance);
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

    // --- Issue #98 slice 1: a pending create with an out-of-range native FormID blocks the ESL
    // toggle, even though every *committed* native record is in range. ---

    [Fact]
    public void StageEdit_ToggleEsl_PendingCreateFormIdOutOfRange_ReturnsEslIneligible()
    {
        var data = new PluginFixtureBuilder("eo-header-esl-pending-create")
            .WithPlugin(
                "Pending.esp",
                mod =>
                {
                    mod.Npcs.AddNew("InRangeNpc"); // native, within ESL range
                    ((Mutagen.Bethesda.Plugins.Records.IMod)mod).NextFormID = 0x1000; // force the next reservation out of range
                },
                // Default write behavior recalculates NextFormID from the max FormID actually present
                // (NextFormIDOption.Iterate) — NoCheck preserves our manual override above.
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    NextFormID = Mutagen.Bethesda.Plugins.Binary.Parameters.NextFormIDOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var created = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Pending.esp", "npc_", null, "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Pending.esp"), "Pending.esp", fields, "user", null);

                var esl = Assert.IsType<StageEditResult.EslIneligible>(result);
                Assert.Equal("Pending.esp", esl.Plugin);
                Assert.Contains(created.FormKey, esl.FormKeys);
            }
        }
    }

    // --- Issue #98 slice 1b: a pending renumber TO an out-of-range native FormID blocks the ESL
    // toggle, even though the record's *committed* FormID is in range. ---

    [Fact]
    public void StageEdit_ToggleEsl_PendingRenumberToFormIdOutOfRange_ReturnsEslIneligible()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-header-esl-pending-renumber")
            .WithPlugin("Renum.esp", mod => npcKey = mod.Npcs.AddNew("N").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<RenumberResult.Staged>(
                    orchestrator.Renumber(npcKey.ToString(), 0x1000, "Renum.esp", "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Renum.esp"), "Renum.esp", fields, "user", null);

                var esl = Assert.IsType<StageEditResult.EslIneligible>(result);
                Assert.Equal("Renum.esp", esl.Plugin);
                Assert.Contains("001000:Renum.esp", esl.FormKeys);
            }
        }
    }

    // --- Issue #98 slice 1c: a pending renumber FROM an out-of-range committed native FormID TO an
    // in-range one lets the ESL toggle stage — the stale high FormID must not still count against
    // eligibility once the renumber has moved it out of the way. ---

    [Fact]
    public void StageEdit_ToggleEsl_PendingRenumberFixesOutOfRangeFormId_Stages()
    {
        var outOfRange = FormKey.Factory("001500:Fix.esp"); // 0x1500 > 0xFFF
        var data = new PluginFixtureBuilder("eo-header-esl-pending-renumber-fix")
            .WithPlugin("Fix.esp", mod =>
                mod.Npcs.Add(new Npc(outOfRange, Fallout4Release.Fallout4) { EditorID = "OutOfRangeNpc" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<RenumberResult.Staged>(
                    orchestrator.Renumber(outOfRange.ToString(), 0x0500, "Fix.esp", "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Fix.esp"), "Fix.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Issue #98 slice 2: committed + pending native FormIDs all in range still stages —
    // regression guard confirming the union doesn't introduce false positives. ---

    [Fact]
    public void StageEdit_ToggleEsl_CommittedAndPendingAllInRange_Stages()
    {
        var data = new PluginFixtureBuilder("eo-header-esl-pending-ok")
            .WithPlugin("Ok.esp", mod => mod.Npcs.AddNew("InRangeNpc")) // native, within ESL range
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // The plugin's default NextFormID reservation counter is already in-range for a
                // freshly-built fixture, so this pending create's FormKey is in-range too.
                Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Ok.esp", "npc_", null, "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Ok.esp"), "Ok.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Issue #98 slice 5: an out-of-range record native to a *master* never counts against the
    // target plugin's ESL eligibility — even when combined with the target's own in-range pending
    // create and an override of the master's out-of-range record. Regression guard on the pending
    // union (Slice 1) reusing the same native-ModKey filter as the committed read (Slice 7c). ---

    [Fact]
    public void StageEdit_ToggleEsl_OverrideOfHighIdMasterPlusPendingCreate_Stages()
    {
        var masterNpc = FormKey.Factory("005000:Base.esm"); // 0x5000 > 0xFFF, but native to Base.esm
        var data = new PluginFixtureBuilder("eo-header-esl-override-pending")
            .WithPlugin("Base.esm", mod =>
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpc" }))
            .WithPlugin("Patch.esp", mod =>
            {
                mod.Npcs.AddNew("PatchNativeNpc"); // native, within ESL range
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpcOverride" });
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // The plugin's default NextFormID counter is in-range for a freshly-built fixture.
                Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Patch.esp", "npc_", null, "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Patch.esp"), "Patch.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
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

    // --- Issue #335/ADR-0038: masters is no longer directly user-editable — any staged edit
    // against the header's masters field is rejected outright, regardless of what it proposes.
    // (Was issue #86's validated, add-only plugin-reference array; #283 design review found a
    // real but out-of-scope use for a manually-declared master (load-order pinning) and decided
    // nothing may declare a master except content that references it — ADR-0038.) ---

    private static JsonElement MastersJson(params string[] plugins) =>
        JsonSerializer.SerializeToElement(plugins);

    // A proposal that would have been a perfectly valid append under the old add-only rule is
    // rejected all the same — proves the guard no longer inspects content at all, not just that
    // it still catches the invalid shapes the old rule caught.
    [Fact]
    public void StageEdit_MastersDirectEdit_ValidAppend_IsRejected()
    {
        var data = new PluginFixtureBuilder("eo-header-masters-valid-append-rejected")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base.esm") };

                var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                var error = Assert.Single(invalid.Errors);
                Assert.Equal("masters", error.FieldPath);
                Assert.Equal("read_only", error.Reason);
            }
        }
    }

    // A malformed non-array shape is rejected too, same reason as a well-formed proposal — the
    // guard never gets far enough to look at shape (ADR-0026: never stage an edit that looks
    // accepted but does nothing, even trivially true here since nothing is ever accepted).
    [Fact]
    public void StageEdit_MastersDirectEdit_MalformedShape_IsRejected()
    {
        var data = new PluginFixtureBuilder("eo-header-masters-malformed-rejected")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["masters"] = J("\"not-an-array\"") };

                var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Equal("read_only", Assert.Single(invalid.Errors).Reason);
            }
        }
    }

    // --- Issue #86 invariant B, re-grounded by #336/ADR-0038: "the target ends up referencing
    // every origin it needs" now holds by construction through the derived read
    // (RecordQueryService.GetEffectiveMasters), not through a staged header pending-change row —
    // CopyRecordTo stages the copy's own fields only. Grouping with the header (ADR-0028's former
    // added-master union rule) and the multi-copy "share one group" guarantee both went with the
    // deleted row: they were an artifact of that mechanism, not a real dependency between unrelated
    // copies. #338 deleted the union rule itself, since it could no longer match anything.

    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes, RecordQueryService query)
        MakeOrchestratorWithChanges()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector, TestRecordVendor.Create(), TestRecordReverter.Create(), NullLogger<EditOrchestrator>.Instance);
        return (orchestrator, manager, changes, query);
    }

    // --- B4: the copied record's own origin plugin is reflected in the derived read, no header
    // row staged. ---

    [Fact]
    public void CopyRecordTo_TargetMissingSourceAsMaster_EffectiveMastersIncludesSourceOriginNoRowStaged()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-master-origin")
            .WithPlugin("Base.esm", mod => npcKey = mod.Npcs.AddNew("BaseNpc").FormKey)
            .WithPlugin("Target.esp") // no masters declared
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes, query) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);

                var headerKey = HeaderKey("Target.esp");

                // No masters pending row exists — nothing left to group the copy's fields with,
                // same "groups of one" shape B6 below already established for a copy that needs
                // no master.
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: headerKey));
                Assert.All(changes.GetChangeGroups(), g => Assert.Equal("field_edit", g.Operation));

                Assert.Equal(["Base.esm"], query.GetEffectiveMasters("Target.esp", "Data"));

                // Reverting the copy (by FormKey — the whole-record revert a real "revert this
                // record" action uses) needs no separate masters cleanup: the derived read
                // reflects the revert automatically (AC3), with no orphaned pending state.
                changes.Revert(plugin: "Target.esp", formKey: npcKey.ToString());
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: npcKey.ToString()));
                Assert.Empty(query.GetEffectiveMasters("Target.esp", "Data"));
            }
        }
    }

    // --- B4 regression, re-grounded: two sequential copy-tos needing different missing masters
    // used to share one group only because both unioned against the same masters-add row (#112-era
    // guard). With that row gone, they have no genuine dependency on each other and land in
    // separate groups — more correct, not a regression (ADR-0028: a group is a derived dependency
    // closure), and each remains independently revertible with its own masters need correctly
    // reflected. ---

    [Fact]
    public void CopyRecordTo_TwoSequentialCopiesNeedingDifferentMasters_EachIndependentlyRevertible()
    {
        FormKey npc1Key = default;
        FormKey npc2Key = default;
        var data = new PluginFixtureBuilder("eo-copy-master-sequential")
            .WithPlugin("Origin1.esm", mod => npc1Key = mod.Npcs.AddNew("Origin1Npc").FormKey)
            .WithPlugin("Origin2.esm", mod => npc2Key = mod.Npcs.AddNew("Origin2Npc").FormKey)
            .WithPlugin("Target.esp") // no masters declared
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes, query) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<StageEditResult.Staged>(orchestrator.CopyRecordTo(npc1Key.ToString(), "Target.esp", "user"));
                Assert.IsType<StageEditResult.Staged>(orchestrator.CopyRecordTo(npc2Key.ToString(), "Target.esp", "user"));

                var headerKey = HeaderKey("Target.esp");
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: headerKey));
                Assert.Equal(["Origin1.esm", "Origin2.esm"], query.GetEffectiveMasters("Target.esp", "Data"));

                // Reverting npc1 leaves npc2 — and only npc2's own implied master — staged.
                changes.Revert(plugin: "Target.esp", formKey: npc1Key.ToString());
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: npc1Key.ToString()));
                Assert.NotEmpty(changes.GetChanges(plugin: "Target.esp", formKey: npc2Key.ToString()));
                Assert.Equal(["Origin2.esm"], query.GetEffectiveMasters("Target.esp", "Data"));
            }
        }
    }

    // --- B5: a FormLink inside the copied content, referencing a third plugin, is reflected in the
    // derived read too — independent of the record's own origin (already mastered here). ---

    [Fact]
    public void CopyRecordTo_ContentReferencesUnmasteredPlugin_EffectiveMastersIncludesItNoRowStaged()
    {
        FormKey npcKey = default;
        FormKey raceKey = default;
        var data = new PluginFixtureBuilder("eo-copy-master-formref")
            .WithPlugin("RaceProvider.esm", mod => raceKey = mod.Races.AddNew("ImportedRace").FormKey)
            .WithPlugin("Origin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("OriginNpc");
                npc.Race.SetTo(raceKey);
                npcKey = npc.FormKey;
            })
            .WithPlugin(
                "Target.esp",
                mod => ((Mutagen.Bethesda.Plugins.Records.IMod)mod).MasterReferences.Add(
                    new Mutagen.Bethesda.Plugins.Records.MasterReference { Master = ModKey.FromFileName("Origin.esp") }),
                // Target doesn't yet reference Origin.esp's content, so the declared master would
                // otherwise be pruned at fixture-build write time (default MastersListContentOption.
                // Iterate) — NoCheck preserves it so this test isolates the FormLink-referenced-plugin
                // gap (RaceProvider.esm) from the origin-plugin gap (B4).
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes, query) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);

                var headerKey = HeaderKey("Target.esp");
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: headerKey));

                // Origin.esp was already a committed master (excluded); only the FormLink's origin
                // (RaceProvider.esm) is newly implied.
                Assert.Equal(["Origin.esp", "RaceProvider.esm"], query.GetEffectiveMasters("Target.esp", "Data"));
            }
        }
    }

    // --- B6: a copy into a target that already masters everything referenced needs no masters
    // change — unchanged by #336, since none was ever staged for this case either. ---

    [Fact]
    public void CopyRecordTo_TargetAlreadyMastersSource_NoMastersChangeStaged()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-master-already")
            .WithPlugin("Base.esm", mod => npcKey = mod.Npcs.AddNew("BaseNpc").FormKey)
            .WithPlugin(
                "Target.esp",
                mod => ((Mutagen.Bethesda.Plugins.Records.IMod)mod).MasterReferences.Add(
                    new Mutagen.Bethesda.Plugins.Records.MasterReference { Master = ModKey.FromFileName("Base.esm") }),
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes, query) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);

                var headerKey = HeaderKey("Target.esp");

                // The subject: no masters change staged, because Target.esp already masters Base.esm.
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: headerKey));
                Assert.Equal(["Base.esm"], query.GetEffectiveMasters("Target.esp", "Data"));

                // ADR-0028 abolishes the ungrouped change: with no master-add to entangle them (edge
                // rule 3) and no lifecycle change in sight, the copied fields are simply groups of
                // one. That is the fix for #112, not a regression — before it, these changes had a
                // null group_id and so could never be shown or saved at all.
                var groups = changes.GetChangeGroups();
                Assert.NotEmpty(groups);
                Assert.All(groups, g => Assert.Equal("field_edit", g.Operation));
                Assert.DoesNotContain(headerKey, groups.SelectMany(g => changes.GetChanges(memberChangeId: g.Id)).Select(c => c.FormKey));
            }
        }
    }

    // --- AC5 (#336/ADR-0038): the automatic door slice 1 left open is now closed too — no
    // production path stages a pending-change row targeting the header's masters field at all,
    // needing a master or not. This is the invariant #338's deleted added-master edge rule
    // (PendingChangeGraph.ApplyAddedMasterRule) depended on for its own deletion to be safe: the
    // rule only ever matched a node satisfying that shape, and with no path able to produce one,
    // its loop body was dead over every reachable state. CopyRecordTo is the one path that could
    // plausibly violate it — the pre-#336 auto-add-master step lived here — so it's the only one
    // exercised below; StageEdit's direct masters edit is separately rejected outright by #335's
    // guard (StageEdit_MastersDirectEdit_ValidAppend_IsRejected above), and no other staging path
    // ever touches the masters field at all. ---

    [Fact]
    public void NoProductionPathStagesAPendingChangeRowTargetingTheHeadersMastersField()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-master-ac5")
            .WithPlugin("Base.esm", mod => npcKey = mod.Npcs.AddNew("BaseNpc").FormKey)
            .WithPlugin("Target.esp") // no masters declared — the case most likely to need one
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.DoesNotContain(
                    changes.GetChanges(),
                    c => c.RecordType == HeaderIndexer.TableName && c.FieldPath == HeaderIndexer.MastersFieldName);
            }
        }
    }
}
