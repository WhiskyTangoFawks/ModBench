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
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Edits;

public sealed class EditOrchestratorTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

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

    // --- StageEdit ---

    [Fact]
    public void StageEdit_ValidEdit_StagesChange()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-valid-edit")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Single(staged.Changes);
                Assert.Equal("aggression", staged.Changes[0].FieldPath);
                // Verify old value was captured (kills mutants on null-check and ContainsKey)
                Assert.NotEqual(System.Text.Json.JsonValueKind.Null, staged.Changes[0].OldValue.ValueKind);
            }
        }
    }

    [Fact]
    public void StageEdit_PluginHasNoOverride_OldValueIsNull()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-no-override")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Target.esp")  // empty — no override of npcKey
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                // Target.esp has no existing record for npcKey → currentRecord will be null → OldValue stored as null
                var result = orchestrator.StageEdit(npcKey.ToString(), "Target.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Equal(System.Text.Json.JsonValueKind.Null, staged.Changes[0].OldValue.ValueKind);
            }
        }
    }

    [Fact]
    public void StageEdit_RecordNotFound_ReturnsRecordNotFound()
    {
        var data = new PluginFixtureBuilder("eo-not-found")
            .WithPlugin("TestPlugin.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit("FFFFFF:NoSuch.esp", "TestPlugin.esp", fields, "user", null);

                Assert.IsType<StageEditResult.RecordNotFound>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_ImmutablePlugin_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-immutable")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            // Use a stub session that marks the plugin as immutable
            var sessionStub = new StubSessionManagerWithImmutablePlugin(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "TestPlugin.esp");

            var reflector = new SchemaReflector();
            var changes = DuckDbTestFactory.MakePendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes, reflector);

            var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

            var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("TestPlugin.esp", immutable.Plugin);
        }
    }

    [Fact]
    public void StageEdit_ReadOnlyField_ReturnsReadOnlyFields()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-readonly")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["form_key"] = J("\"anything\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

                var readOnly = Assert.IsType<StageEditResult.ReadOnlyFields>(result);
                Assert.Contains("form_key", readOnly.Fields);
            }
        }
    }

    [Fact]
    public void StageEdit_PluginNotInSession_DoesNotThrow()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-unknown-plugin")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "NotLoaded.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_KeywordsArrayReferencingCommittedRecord_Passes()
    {
        // Verifies LookupRecordType checks the committed store first.
        // keywords is a writable array-of-formKey field — ValidateReferences walks it and calls
        // LookupRecordType for each element. With the mutation (committed != null → committed == null),
        // LookupRecordType skips the committed store and returns null → InvalidReferences.
        FormKey kwKey = default;
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-kw-ref-committed")
            .WithPlugin("Source.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew("TestKw_EoFkRef").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_EoFkRef").FormKey;
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
                    ["keywords"] = J($"[\"{kwKey}\"]")
                };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_NoSession_ReturnsNoSession()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

            var result = orchestrator.StageEdit("ABC:000001:X.esp", "X.esp", fields, "user", null);

            Assert.IsType<StageEditResult.NoSession>(result);
        }
    }

    // --- Phase 16.2.2: placed create / copy ---

    // Builds a worldspace cell holding one persistent placed object in the named plugin,
    // capturing the cell + placed FormKeys.
    private static PluginFixtureData PlacedFixture(
        string prefix, string plugin, out string cellFk, out string placedFk)
    {
        string cell = "", placed = "";
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin(plugin, mod =>
            {
                var wrld = mod.Worldspaces.AddNew("TestWorld");
                var c = new Cell(mod) { EditorID = "TestCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                var po = new PlacedObject(mod) { EditorID = "placedRef", Position = new P3Float(1f, 2f, 3f) };
                c.Persistent.Add(po);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(c);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                wrld.SubCells.Add(block);
                cell = c.FormKey.ToString();
                placed = po.FormKey.ToString();
            })
            .WithPlugin("Target.esp")
            .Build();
        cellFk = cell;
        placedFk = placed;
        return data;
    }

    [Fact]
    public void CreatePlacedRecord_StagesCreateChangeCarryingPlacement()
    {
        var data = new PluginFixtureBuilder("eo-create-placed")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreatePlacedRecord(
                        "Target.esp", "refr", "001234:Fallout4.esm", "temporary", null, "user"));

                var createChange = changes.GetChanges(formKey: result.FormKey).Single(c => c.FieldPath == "$create");
                Assert.Equal("001234:Fallout4.esm", createChange.ParentCell);
                Assert.Equal("temporary", createChange.PlacementGroup);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_PlacedWinner_StagesChangesCarryingPlacement()
    {
        var data = PlacedFixture("eo-copy-placed", "Source.esp", out var cellFk, out var placedFk);
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(placedFk, "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var staged = changes.GetChanges(formKey: placedFk, plugin: "Target.esp");
                Assert.NotEmpty(staged);
                Assert.All(staged, c => Assert.Equal(cellFk, c.ParentCell));
                Assert.All(staged, c => Assert.Equal("persistent", c.PlacementGroup));
            }
        }
    }

    [Fact]
    public void CopyRecordTo_NonPlacedWinner_StagesNullPlacement()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-nonplaced")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = changes.GetChanges(formKey: npcKey.ToString(), plugin: "Target.esp");
                Assert.NotEmpty(staged);
                Assert.All(staged, c => Assert.Null(c.ParentCell));
                Assert.All(staged, c => Assert.Null(c.PlacementGroup));
            }
        }
    }

    // --- CopyRecordTo ---

    [Fact]
    public void CopyRecordTo_ValidCopy_StagesAllWinnerFields()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-to")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TestNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.NotEmpty(staged.Changes);
                Assert.All(staged.Changes, c => Assert.Equal("Target.esp", c.Plugin));
            }
        }
    }

    [Fact]
    public void CopyRecordTo_RecordNotFound_ReturnsRecordNotFound()
    {
        var data = new PluginFixtureBuilder("eo-copy-notfound")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo("FFFFFF:NoSuch.esp", "Target.esp", "user");

                Assert.IsType<StageEditResult.RecordNotFound>(result);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ImmutableTarget_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-immutable")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var sessionStub = new StubSessionManagerWithImmutablePlugin(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "Source.esp");

            var reflector = new SchemaReflector();
            var changes = DuckDbTestFactory.MakePendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes, reflector);

            var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Source.esp", "user");

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("Source.esp", immutable.Plugin);
        }
    }

    [Fact]
    public void CopyRecordTo_TargetAlreadyHasOverride_OldValueIsPopulated()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-override")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("SourceNPC");
                npc.Aggression = Mutagen.Bethesda.Fallout4.Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp", mod =>
            {
                // Create override: same FormKey, different aggression value
                var overrideNpc = new Mutagen.Bethesda.Fallout4.Npc(npcKey, Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
                overrideNpc.Aggression = Mutagen.Bethesda.Fallout4.Npc.AggressionType.Unaggressive;
                mod.Npcs.Add(overrideNpc);
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.NotEmpty(staged.Changes);
                // Target had an existing override → old values should be populated (not all null)
                Assert.Contains(staged.Changes, c =>
                    c.OldValue.ValueKind != System.Text.Json.JsonValueKind.Null);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_NoSession_ReturnsNoSession()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            var result = orchestrator.CopyRecordTo("FFFFFF:NoSuch.esp", "Target.esp", "user");

            Assert.IsType<StageEditResult.NoSession>(result);
        }
    }


    [Fact]
    public void CopyRecordTo_TargetRecordGroupOwned_ReturnsBlockedByGroup()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-group-owned")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_CopyGroupOwned").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var members = new[] { new GroupMember(npcKey.ToString(), "Target.esp", "npc_", "create", "name", J("null"), J("\"x\"")) };
                changes.StageGroup("create", null, members);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.BlockedByGroup>(result);
            }
        }
    }

    // --- StageEdit form-ref tests ---

    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestratorWithChanges()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager, changes);
    }

    [Fact]
    public void CopyRecordTo_ScalarFormKeyField_StagesFormReference()
    {
        FormKey npcKey = default;
        FormKey raceKey = default;
        var data = new PluginFixtureBuilder("eo-copy-scalar-fk")
            .WithPlugin("Source.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace_ScalarFk");
                raceKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC_ScalarFk");
                npc.Race.SetTo(race.FormKey);
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var drained = changes.DrainForPlugin("Target.esp");
                var raceRef = drained.FormRefsByFormKey[npcKey.ToString()]
                    .FirstOrDefault(r => r.FieldPath == "race");
                Assert.NotNull(raceRef);
                Assert.Equal(raceKey.ToString(), raceRef.TargetFormKey);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ArrayFormKeyField_StagesFormReferencesWithIndices()
    {
        FormKey npcKey = default;
        FormKey kw1Key = default;
        FormKey kw2Key = default;
        var data = new PluginFixtureBuilder("eo-copy-array-fk")
            .WithPlugin("Source.esp", mod =>
            {
                var kw1 = mod.Keywords.AddNew();
                kw1.EditorID = "TestKw1_ArrayFk";
                kw1Key = kw1.FormKey;
                var kw2 = mod.Keywords.AddNew();
                kw2.EditorID = "TestKw2_ArrayFk";
                kw2Key = kw2.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC_ArrayFk");
                npc.Keywords = [new FormLink<IKeywordGetter>(kw1Key), new FormLink<IKeywordGetter>(kw2Key)];
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var drained = changes.DrainForPlugin("Target.esp");
                var refs = drained.FormRefsByFormKey[npcKey.ToString()]
                    .Where(r => r.FieldPath.StartsWith("keywords", StringComparison.Ordinal))
                    .OrderBy(r => r.FieldPath).ToList();
                Assert.Equal(2, refs.Count);
                Assert.Equal("keywords[0]", refs[0].FieldPath);
                Assert.Equal(kw1Key.ToString(), refs[0].TargetFormKey);
                Assert.Equal("keywords[1]", refs[1].FieldPath);
                Assert.Equal(kw2Key.ToString(), refs[1].TargetFormKey);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ArrayOfStructFormKeyField_StagesFormReference()
    {
        FormKey npcKey = default;
        FormKey factionKey = default;
        var data = new PluginFixtureBuilder("eo-copy-struct-fk")
            .WithPlugin("Source.esp", mod =>
            {
                factionKey = mod.Factions.AddNew("TestFaction_StructFk").FormKey;
                var npc = mod.Npcs.AddNew("TestNPC_StructFk");
                npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(factionKey) });
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var drained = changes.DrainForPlugin("Target.esp");
                var factionRef = drained.FormRefsByFormKey[npcKey.ToString()]
                    .FirstOrDefault(r => r.FieldPath == "factions[0].faction");
                Assert.NotNull(factionRef);
                Assert.Equal(factionKey.ToString(), factionRef.TargetFormKey);
            }
        }
    }

    [Fact]
    public void StageEdit_KeywordsField_NullStringElement_YieldsNoRef()
    {
        FormKey npcKey = default;
        FormKey kwKey = default;
        var data = new PluginFixtureBuilder("eo-stage-kw-null")
            .WithPlugin("Source.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew().FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_KwNull").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var keywordsJson = J($"[\"Null\",\"{kwKey}\"]");
                var fields = new Dictionary<string, JsonElement> { ["keywords"] = keywordsJson };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
                var drained = changes.DrainForPlugin("Source.esp");
                var kwRefs = drained.FormRefsByFormKey[npcKey.ToString()]
                    .Where(r => r.FieldPath.StartsWith("keywords", StringComparison.Ordinal))
                    .ToList();
                Assert.Single(kwRefs);
                Assert.Equal("keywords[1]", kwRefs[0].FieldPath);
                Assert.Equal(kwKey.ToString(), kwRefs[0].TargetFormKey);
            }
        }
    }

    [Fact]
    public void StageEdit_FactionsField_ExtractsStructSubFieldFormRefsWithCorrectIndices()
    {
        FormKey npcKey = default;
        FormKey faction1Key = default;
        FormKey faction2Key = default;
        var data = new PluginFixtureBuilder("eo-stage-struct-fk-idx")
            .WithPlugin("Source.esp", mod =>
            {
                faction1Key = mod.Factions.AddNew("TestFaction1_StageIdx").FormKey;
                faction2Key = mod.Factions.AddNew("TestFaction2_StageIdx").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_StageIdx").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var factionsJson = J($"[{{\"faction\":\"{faction1Key}\",\"rank\":0}},{{\"faction\":\"{faction2Key}\",\"rank\":1}}]");
                var fields = new Dictionary<string, JsonElement> { ["factions"] = factionsJson };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
                var drained = changes.DrainForPlugin("Source.esp");
                var refs = drained.FormRefsByFormKey[npcKey.ToString()]
                    .Where(r => r.FieldPath.StartsWith("factions", StringComparison.Ordinal))
                    .OrderBy(r => r.FieldPath).ToList();
                Assert.Equal(2, refs.Count);
                Assert.Equal("factions[0].faction", refs[0].FieldPath);
                Assert.Equal(faction1Key.ToString(), refs[0].TargetFormKey);
                Assert.Equal("factions[1].faction", refs[1].FieldPath);
                Assert.Equal(faction2Key.ToString(), refs[1].TargetFormKey);
            }
        }
    }

    [Theory]
    [InlineData("[{\"faction\":\"Null\",\"rank\":0}]")]
    [InlineData("[{\"faction\":42,\"rank\":0}]")]
    public void StageEdit_FactionsField_InvalidFactionValue_ReturnsInvalidReferences(string factionsRaw)
    {
        // RankPlacement.Faction is a non-nullable FormLink<IFactionGetter> — a null/malformed
        // value is now rejected at stage time instead of silently staging with no ref.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-struct-fk-invalid")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_StageInvalid").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J(factionsRaw) };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Single(invalid.Errors);
                Assert.Equal("factions[0].faction", invalid.Errors[0].FieldPath);
                Assert.Equal("null_not_allowed", invalid.Errors[0].Reason);
            }
        }
    }

    [Fact]
    public void StageEdit_FormLink_TargetNotInSession_ReturnsInvalidReferences()
    {
        // RankPlacement.Faction is a non-nullable FormLink<IFactionGetter>; pointing it at a
        // well-formed FormKey that doesn't resolve to any record in the session is a data error.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-faction-missing")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_FactionMissing").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J("[{\"faction\":\"0000FF:Source.esp\",\"rank\":0}]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Single(invalid.Errors);
                Assert.Equal("factions[0].faction", invalid.Errors[0].FieldPath);
                Assert.Equal("not_in_session", invalid.Errors[0].Reason);
            }
        }
    }

    [Fact]
    public void StageEdit_FormLink_TypeMismatch_ReturnsInvalidReferences()
    {
        FormKey npcKey = default;
        FormKey otherNpcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-faction-mismatch")
            .WithPlugin("Source.esp", mod =>
            {
                otherNpcKey = mod.Npcs.AddNew("TestNPC_WrongType").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_FactionMismatch").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J($"[{{\"faction\":\"{otherNpcKey}\",\"rank\":0}}]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Single(invalid.Errors);
                Assert.Equal("factions[0].faction", invalid.Errors[0].FieldPath);
                Assert.Equal("type_mismatch", invalid.Errors[0].Reason);
            }
        }
    }

    [Fact]
    public void StageEdit_FormLink_ValidReference_Stages()
    {
        FormKey npcKey = default;
        FormKey factionKey = default;
        var data = new PluginFixtureBuilder("eo-stage-faction-valid")
            .WithPlugin("Source.esp", mod =>
            {
                factionKey = mod.Factions.AddNew("TestFaction_Valid").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_FactionValid").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J($"[{{\"faction\":\"{factionKey}\",\"rank\":0}}]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_NullableFormLinkArrayElement_SetToNull_Stages()
    {
        // Keywords elements are declared as the ambiguous base IFormLinkGetter<IKeywordGetter>
        // (neither IFormLink<T> nor IFormLinkNullable<T>) — treated as nullable since nothing
        // in the type forbids it. Covered structurally by StageEdit_KeywordsField_NullStringElement_YieldsNoRef;
        // this asserts the same input is still accepted now that reference validation runs.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-keyword-null")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_KeywordNull").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["keywords"] = J("[\"Null\"]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- CreateRecord ---

    [Fact]
    public void CreateRecord_NoTemplate_StagedWithCorrectShapeAndGroup()
    {
        var data = new PluginFixtureBuilder("cr-shape")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));

                var staged = changes.GetChanges(formKey: result.FormKey);
                Assert.Single(staged);
                Assert.Equal("$create", staged[0].FieldPath);
                Assert.Equal("create", staged[0].ChangeType);
                Assert.Equal(JsonValueKind.Null, staged[0].NewValue.ValueKind);
                Assert.Equal(result.GroupId, staged[0].GroupId);
                Assert.Equal(result.FormKey, staged[0].FormKey);

                var groups = changes.GetChangeGroups();
                Assert.Single(groups);
                Assert.Equal(result.GroupId, groups[0].Id);
            }
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_StagesSeparateFieldEditChanges()
    {
        FormKey templateKey = default;
        var data = new PluginFixtureBuilder("cr-template")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TemplateNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                templateKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", templateKey.ToString(), "user"));

                var staged = changes.GetChanges(formKey: result.FormKey);
                // $create sentinel + N field_edit changes from template
                Assert.True(staged.Count > 1, "Expected $create plus at least one field_edit from template");
                var createChange = staged.Single(c => c.FieldPath == "$create");
                Assert.Equal(JsonValueKind.Null, createChange.NewValue.ValueKind);
                Assert.Equal(result.GroupId, createChange.GroupId);
                var fieldEdits = staged.Where(c => c.FieldPath != "$create").ToList();
                Assert.All(fieldEdits, c =>
                {
                    Assert.Equal("field_edit", c.ChangeType);
                    Assert.Equal(result.GroupId, c.GroupId);
                });
            }
        }
    }

    [Fact]
    public void CreateRecord_UnknownRecordType_ThrowsArgumentException()
    {
        var data = new PluginFixtureBuilder("cr-unknown-type")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.Throws<ArgumentException>(() =>
                    orchestrator.CreateRecord("Target.esp", "not_a_real_type", null, "user"));
            }
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_TemplateNotFound_ThrowsArgumentException()
    {
        var data = new PluginFixtureBuilder("cr-template-missing")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.Throws<ArgumentException>(() =>
                    orchestrator.CreateRecord("Target.esp", "npc_", "FFFFFF:NotReal.esp", "user"));
            }
        }
    }

    // --- Dependent change grouping ---

    [Fact]
    public void StageEdit_ReferencesCreatedFormKey_JoinsCreationGroup()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dep-group-join")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("SourceNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Create a new Faction in Target.esp (factions[].faction requires a Faction-typed reference)
                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "fact", null, "user"));
                var newFormKey = createResult.FormKey;

                // Stage an edit on SourceNPC that references the newly-created FormKey via factions
                var factionList = JsonSerializer.SerializeToElement(
                    new[] { new { faction = newFormKey, rank = 0 } });
                var fields = new Dictionary<string, JsonElement> { ["factions"] = factionList };

                orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var allChanges = changes.GetChanges();
                var dependentChange = allChanges.FirstOrDefault(c =>
                    c.FormKey == npcKey.ToString() && c.FieldPath == "factions");
                Assert.NotNull(dependentChange);
                Assert.Equal(createResult.GroupId, dependentChange.GroupId);
            }
        }
    }

    [Fact]
    public void StageEdit_NoCreatedFormKeyRefs_GroupIdIsNull()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dep-group-null")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("SourceNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var fields = new Dictionary<string, JsonElement>
                {
                    ["aggression"] = JsonSerializer.SerializeToElement("Frenzied")
                };
                orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var allChanges = changes.GetChanges();
                var change = allChanges.Single(c => c.FieldPath == "aggression");
                Assert.Null(change.GroupId);
            }
        }
    }

    [Fact]
    public void RevertGroup_RemovesCreateAndDependentEdits()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dep-group-revert")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("SourceNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));
                var factionList = JsonSerializer.SerializeToElement(
                    new[] { new { faction = createResult.FormKey, rank = 0 } });
                var fields = new Dictionary<string, JsonElement> { ["factions"] = factionList };
                orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                changes.RevertGroup(createResult.GroupId);

                Assert.Empty(changes.GetChanges());
            }
        }
    }

    [Fact]
    public void CreateRecord_NoSession_ThrowsInvalidOperationException()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            Assert.Throws<InvalidOperationException>(() =>
                orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_InvalidArrayReference_ReturnsInvalidReferences_WithoutStagingAnything()
    {
        // Set factions[0].faction to another NPC's FormKey (type_mismatch): factions is an array
        // of structs with a non-nullable FormLink<IFactionGetter>, so pointing it at an NPC
        // triggers a type_mismatch validation error. Array fields ARE copied from the template
        // (they have an Apply lambda), so this exercises the validation gap.
        FormKey templateKey = default;
        FormKey wrongTypeKey = default;
        var data = new PluginFixtureBuilder("cr-template-invalid-array-ref")
            .WithPlugin("Source.esp", mod =>
            {
                wrongTypeKey = mod.Npcs.AddNew("OtherNPC_NotAFaction").FormKey;
                var npc = mod.Npcs.AddNew("TemplateNPC_InvalidArrayRef");
                npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(wrongTypeKey) });
                templateKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var outcome = orchestrator.CreateRecord("Target.esp", "npc_", templateKey.ToString(), "user");

                var inv = Assert.IsType<CreateRecordOutcome.InvalidReferences>(outcome);
                Assert.Contains(inv.Errors, e => e.FieldPath == "factions[0].faction" && e.Reason == "type_mismatch");
                // Nothing should have been staged — not even the $create sentinel
                Assert.Empty(changes.GetChanges());
            }
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_ExcludesReadOnlyFields()
    {
        FormKey templateKey = default;
        var data = new PluginFixtureBuilder("cr-template-ro")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TemplateNPC_RO");
                npc.Aggression = Npc.AggressionType.Frenzied;
                templateKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", templateKey.ToString(), "user"));

                var staged = changes.GetChanges(formKey: result.FormKey);
                var fieldEdits = staged.Where(c => c.FieldPath != "$create").ToList();
                IPluginWriter writer = new PluginWriter(new SchemaReflector(), NullLogger<PluginWriter>.Instance);
                Assert.DoesNotContain(fieldEdits, c => writer.IsReadOnly(GameRelease.Fallout4, "npc_", c.FieldPath));
                Assert.Contains(fieldEdits, c => c.FieldPath == "aggression");
            }
        }
    }

    [Fact]
    public void StageGroup_TargetsCreateSentinel_PreservesCreateGroupId()
    {
        var data = new PluginFixtureBuilder("sg-coalesce")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));

                // StageGroup targeting the same $create sentinel should NOT overwrite its groupId
                var members = new[] { new GroupMember(
                    createResult.FormKey, "Target.esp", "npc_", "create",
                    "$create", J("null"), J("null")) };
                changes.StageGroup("some_op", null, members);

                var staged = changes.GetChanges(formKey: createResult.FormKey);
                var createChange = staged.Single(c => c.FieldPath == "$create");
                Assert.Equal(createResult.GroupId, createChange.GroupId);
            }
        }
    }

    // --- helpers ---

    /// <summary>
    /// Wraps a real SessionManager but overrides one plugin's IsImmutable to true.
    /// Used to test immutability enforcement without needing actual base-game files.
    /// </summary>
    private sealed class StubSessionManagerWithImmutablePlugin : ISessionManager, IDisposable
    {
        private readonly SessionManager _inner;
        private readonly IGameSession? _stubSession;

        public StubSessionManagerWithImmutablePlugin(
            string dataFolder, string pluginsTxtPath, GameRelease gameRelease, string immutablePlugin)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            _inner = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            _inner.Load(dataFolder, pluginsTxtPath, gameRelease);
            _stubSession = new ImmutableOverrideSession(_inner.Session!, immutablePlugin);
        }

        public IGameSession? Session => _stubSession;
        public IRecordReader? Repository => _inner.Repository;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public void SetFilter(string sql) => _inner.SetFilter(sql);
        public void ClearFilter() => _inner.ClearFilter();

        public void Dispose() => _inner.Dispose();
    }

    private sealed class ImmutableOverrideSession : IGameSession
    {
        private readonly IGameSession _inner;
        private readonly IReadOnlyList<PluginMetadata> _plugins;

        public ImmutableOverrideSession(IGameSession inner, string immutablePlugin)
        {
            _inner = inner;
            _plugins = inner.Plugins
                .Select(p => p.Name.Equals(immutablePlugin, StringComparison.OrdinalIgnoreCase)
                    ? p with { IsImmutable = true }
                    : p)
                .ToList();
        }

        public string DataFolderPath => _inner.DataFolderPath;
        public GameRelease GameRelease => _inner.GameRelease;
        public IReadOnlyList<PluginMetadata> Plugins => _plugins;
        public ILinkCache LinkCache => _inner.LinkCache;
        public string? FilterSql { get => _inner.FilterSql; set => _inner.FilterSql = value; }
        public IModGetter? GetMod(string pluginName) => _inner.GetMod(pluginName);
        public PluginMetadata AddPlugin(string filePath) => _inner.AddPlugin(filePath);
        public void Dispose() { } // inner managed by StubSessionManagerWithImmutablePlugin
    }
}
