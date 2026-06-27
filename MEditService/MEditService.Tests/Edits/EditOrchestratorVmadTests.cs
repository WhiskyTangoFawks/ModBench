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

public sealed class EditOrchestratorVmadTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestrator(IRecordQueryService? queryOverride = null)
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var query = queryOverride
            ?? new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager, changes);
    }

    private static VirtualMachineAdapter BuildVmad(FormKey targetFk)
    {
        var vmad = new VirtualMachineAdapter();
        var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });

        var objProp = new ScriptObjectProperty { Name = "TargetActor", Alias = -1 };
        objProp.Object.SetTo(targetFk);
        script.Properties.Add(objProp);

        vmad.Scripts.Add(script);
        return vmad;
    }

    // Throws if GetVmad is called — used to assert the guard skips the DB lookup
    private sealed class ThrowOnGetVmadSpy(IRecordQueryService inner) : IRecordQueryService
    {
        public IReadOnlyList<PluginResponse> GetPlugins() => inner.GetPlugins();
        public IReadOnlyList<string> GetRecordTypes() => inner.GetRecordTypes();
        public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset)
            => inner.GetRecords(type, plugin, search, limit, offset);
        public RecordDetail? GetRecord(string formKey) => inner.GetRecord(formKey);
        public RecordDetail? GetRecordForPlugin(string formKey, string plugin) => inner.GetRecordForPlugin(formKey, plugin);
        public string? GetRecordType(string formKey) => inner.GetRecordType(formKey);
        public CompareResult? GetCompare(string formKey) => inner.GetCompare(formKey);
        public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin) => inner.GetPluginRecordTypes(plugin);
        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => inner.GetReferences(targetFormKey);
        public VmadData? GetVmad(string formKey, string plugin) =>
            throw new InvalidOperationException("GetVmad must not be called for non-VMAD edits");
        public PlacementRow? GetPlacement(string formKey, string plugin) => inner.GetPlacement(formKey, plugin);
    }

    // ---- Non-VMAD edit skips GetVmad ----

    [Fact]
    public void StageEdit_NonVmadFields_DoesNotCallGetVmad()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-no-vmad-query")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("Npc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(npc.FormKey);
            })
            .Build();

        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var realQuery = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var spyQuery = new ThrowOnGetVmadSpy(realQuery);
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, spyQuery, writer, changes, reflector);

        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["SomeNonVmadField"] = J("42") }, "user", null);
            Assert.NotNull(result);
        }
    }

    // ---- Variable property rejected at staging ----

    // Wraps a real IRecordQueryService but overrides GetVmad for a specific formKey
    // to return Variable type — Mutagen cannot write ScriptVariableProperty to disk,
    // so we can't build a real fixture for this case.
    private sealed class FakeQueryWithVariableVmad(IRecordQueryService inner, string vmadFormKey) : IRecordQueryService
    {
        public IReadOnlyList<PluginResponse> GetPlugins() => inner.GetPlugins();
        public IReadOnlyList<string> GetRecordTypes() => inner.GetRecordTypes();
        public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset)
            => inner.GetRecords(type, plugin, search, limit, offset);
        public RecordDetail? GetRecord(string formKey) => inner.GetRecord(formKey);
        public RecordDetail? GetRecordForPlugin(string formKey, string plugin) => inner.GetRecordForPlugin(formKey, plugin);
        public string? GetRecordType(string formKey) => inner.GetRecordType(formKey);
        public CompareResult? GetCompare(string formKey) => inner.GetCompare(formKey);
        public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin) => inner.GetPluginRecordTypes(plugin);
        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => inner.GetReferences(targetFormKey);
        public VmadData? GetVmad(string formKey, string plugin)
        {
            if (!formKey.Equals(vmadFormKey, StringComparison.OrdinalIgnoreCase)) return inner.GetVmad(formKey, plugin);
            return new VmadData([
                new VmadScriptData("TestScript", "Local", [
                    new VmadNamedValue("VarProp", new VmadPropertyValue("Variable", "", null))
                ])
            ]);
        }
        public PlacementRow? GetPlacement(string formKey, string plugin) => inner.GetPlacement(formKey, plugin);
    }

    [Fact]
    public void StageEdit_VmadVariableProperty_ReturnsReadOnlyFields()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-var")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = new VirtualMachineAdapter();
                npc.VirtualMachineAdapter.Scripts.Add(
                    new ScriptEntry { Name = "TestScript", Flags = ScriptEntry.Flag.Local });
            })
            .Build();

        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var realQuery = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var fakeQuery = new FakeQueryWithVariableVmad(realQuery, npcFk.ToString());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, fakeQuery, writer, changes, reflector);

        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\TestScript\VarProp"] = J("42")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var ro = Assert.IsType<StageEditResult.ReadOnlyFields>(result);
            Assert.Contains(@"VMAD\TestScript\VarProp", ro.Fields);
        }
    }

    // ---- Staging array VMAD properties ----

    [Fact]
    public void StageEdit_VmadArrayOfBoolEdit_StagedWithOldValueCaptured()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-boolarray")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var arrProp = new ScriptBoolListProperty { Name = "ActiveFlags" };
                arrProp.Data.Add(true);
                script.Properties.Add(arrProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\DefaultScript\ActiveFlags"] = J("[true, false]")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            Assert.Single(staged.Changes);
            var change = staged.Changes[0];
            Assert.Equal(@"VMAD\DefaultScript\ActiveFlags", change.FieldPath);
            Assert.Equal(JsonValueKind.Array, change.NewValue.ValueKind);
            // Old value must be the serialized full array [true] from the plugin
            Assert.Equal(JsonValueKind.Array, change.OldValue.ValueKind);
            var oldArr = change.OldValue.EnumerateArray().ToList();
            Assert.Single(oldArr);
            Assert.Equal(JsonValueKind.True, oldArr[0].ValueKind);
        }
    }

    // ---- Staging a VMAD Bool edit: staged + old value captured ----

    [Fact]
    public void StageEdit_VmadBoolEdit_StagedWithOldValueCaptured()
    {
        FormKey npcFk = default, targetFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-bool")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var target = mod.Npcs.AddNew("Target");
                targetFk = target.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\DefaultScript\IsActive"] = J("false")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            Assert.Single(staged.Changes);
            var change = staged.Changes[0];
            Assert.Equal(@"VMAD\DefaultScript\IsActive", change.FieldPath);
            Assert.Equal(JsonValueKind.False, change.NewValue.ValueKind);

            // Old value must be the in-plugin Bool value (true), not null
            Assert.Equal(JsonValueKind.True, change.OldValue.ValueKind);
        }
    }

    // ---- Unknown script: staged without old value (no crash) ----

    [Fact]
    public void StageEdit_VmadUnknownScript_StagedWithNoOldValue()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-noscript")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = new VirtualMachineAdapter();
                npc.VirtualMachineAdapter.Scripts.Add(
                    new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local });
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\UnknownScript\SomeProp"] = J("true")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            // Staged (not an exception), old value is null since property doesn't exist in DB
            var staged = Assert.IsType<StageEditResult.Staged>(result);
            Assert.Equal(JsonValueKind.Null, staged.Changes[0].OldValue.ValueKind);
        }
    }

    // ---- Known script, unknown property: staged without old value (no crash) ----

    [Fact]
    public void StageEdit_VmadUnknownProperty_StagedWithNoOldValue()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-noprop")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\DefaultScript\UnknownProp"] = J("true")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            // Staged without crash; no old value since property doesn't exist
            var staged = Assert.IsType<StageEditResult.Staged>(result);
            Assert.Equal(JsonValueKind.Null, staged.Changes[0].OldValue.ValueKind);
        }
    }

    // ---- Malformed VMAD path rejected as read-only ----

    [Fact]
    public void StageEdit_MalformedVmadPath_ReturnsReadOnlyFields()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-malformed")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            // Starts with VMAD\ but has no property segment
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\OnlyScript"] = J("true")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var ro = Assert.IsType<StageEditResult.ReadOnlyFields>(result);
            Assert.Contains(@"VMAD\OnlyScript", ro.Fields);
        }
    }

    // ---- Staging a VMAD Object edit adds a form reference ----

    [Fact]
    public void StageEdit_VmadObjectEdit_AddsFormReference()
    {
        FormKey npcFk = default, targetFk = default, altFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-objref")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var target = mod.Npcs.AddNew("Target");
                targetFk = target.FormKey;
                var alt = mod.Npcs.AddNew("AltTarget");
                altFk = alt.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();

        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var json = $"{{\"formKey\":\"{altFk}\",\"alias\":0}}";
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\DefaultScript\TargetActor"] = J(json)
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var oldVal = staged.Changes[0].OldValue;
            Assert.Equal(JsonValueKind.Object, oldVal.ValueKind);
            Assert.True(oldVal.TryGetProperty("formKey", out _));
            Assert.True(oldVal.TryGetProperty("alias", out _));
            var drained = changes.DrainForPlugin("TestPlugin.esp");
            var vmadRef = drained.FormRefsByFormKey[npcFk.ToString()]
                .FirstOrDefault(r => r.FieldPath.Equals(@"VMAD\DefaultScript\TargetActor", StringComparison.Ordinal));
            Assert.NotNull(vmadRef);
            Assert.Equal(altFk.ToString(), vmadRef.TargetFormKey);
        }
    }

    // ---- Staging an ArrayOfObject edit adds per-element form references ----

    [Fact]
    public void StageEdit_VmadArrayOfObjectEdit_AddsFormReferencesPerElement()
    {
        FormKey npcFk = default, fk1 = default, fk2 = default, fk3 = default;
        using var data = new PluginFixtureBuilder("eo-vmad-objlist-refs")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var a = mod.Npcs.AddNew("A"); fk1 = a.FormKey;
                var b = mod.Npcs.AddNew("B"); fk2 = b.FormKey;
                var c = mod.Npcs.AddNew("C"); fk3 = c.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var objList = new ScriptObjectListProperty { Name = "Targets" };
                var existing = new ScriptObjectProperty { Alias = -1 };
                existing.Object.SetTo(fk1);
                objList.Objects.Add(existing);
                script.Properties.Add(objList);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var json = $"[{{\"formKey\":\"{fk2}\",\"alias\":0}},{{\"formKey\":\"{fk3}\",\"alias\":1}}]";
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\DefaultScript\Targets"] = J(json)
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var oldArr = staged.Changes[0].OldValue;
            Assert.Equal(JsonValueKind.Array, oldArr.ValueKind);
            var firstEl = oldArr.EnumerateArray().First();
            Assert.Equal(JsonValueKind.Object, firstEl.ValueKind);
            Assert.True(firstEl.TryGetProperty("formKey", out _));
            Assert.True(firstEl.TryGetProperty("alias", out _));
            var drained = changes.DrainForPlugin("TestPlugin.esp");
            var refs = drained.FormRefsByFormKey[npcFk.ToString()]
                .Where(r => r.FieldPath.Equals(@"VMAD\DefaultScript\Targets", StringComparison.Ordinal))
                .Select(r => r.TargetFormKey)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            Assert.Contains(fk2.ToString(), refs);
            Assert.Contains(fk3.ToString(), refs);
        }
    }

    // ---- 13.8.1 structural ops: staging add/remove property ----

    [Fact]
    public void StageEdit_VmadAddProperty_StagedAsStructOpWithNullOldValue()
    {
        FormKey npcFk = default, targetFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-addprop")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var target = mod.Npcs.AddNew("Target"); targetFk = target.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\DefaultScript\Alpha"] = J("""{"op":"add_property","type":"Int","name":"Alpha","flags":"Edited","value":7}""")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null, "vmad_struct_op");

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var change = Assert.Single(staged.Changes);
            Assert.Equal("vmad_struct_op", change.ChangeType);
            Assert.Equal(@"VMAD\DefaultScript\Alpha", change.FieldPath);
            Assert.Equal(JsonValueKind.Null, change.OldValue.ValueKind);
        }
    }

    [Fact]
    public void StageEdit_VmadAddObjectProperty_AddsFormReference()
    {
        FormKey npcFk = default, targetFk = default, altFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-addobj")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var target = mod.Npcs.AddNew("Target"); targetFk = target.FormKey;
                var alt = mod.Npcs.AddNew("AltTarget"); altFk = alt.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();

        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var op = $$$"""{"op":"add_property","type":"Object","name":"NewRef","flags":"Edited","value":{"formKey":"{{{altFk}}}","alias":0}}""";
            var fields = new Dictionary<string, JsonElement> { [@"VMAD\DefaultScript\NewRef"] = J(op) };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null, "vmad_struct_op");

            Assert.IsType<StageEditResult.Staged>(result);
            var drained = changes.DrainForPlugin("TestPlugin.esp");
            var vmadRef = drained.FormRefsByFormKey[npcFk.ToString()]
                .FirstOrDefault(r => r.FieldPath.Equals(@"VMAD\DefaultScript\NewRef", StringComparison.Ordinal));
            Assert.NotNull(vmadRef);
            Assert.Equal(altFk.ToString(), vmadRef.TargetFormKey);
        }
    }

    [Fact]
    public void StageEdit_VmadAddProperty_ScriptAmongOthers_Staged()
    {
        // Two scripts; add_property targets one of them. Guards against an Any()->All() regression
        // in the "script exists" check (All would be false when a sibling script doesn't match).
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-addprop-multi")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                vmad.Scripts.Add(new ScriptEntry { Name = "ScriptA", Flags = ScriptEntry.Flag.Local });
                vmad.Scripts.Add(new ScriptEntry { Name = "ScriptB", Flags = ScriptEntry.Flag.Local });
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\ScriptA\Alpha"] = J("""{"op":"add_property","type":"Int","name":"Alpha","flags":"Edited","value":1}""")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null, "vmad_struct_op");

            Assert.IsType<StageEditResult.Staged>(result);
        }
    }

    [Fact]
    public void StageEdit_VmadAddProperty_UnknownScript_ReturnsRecordNotFound()
    {
        FormKey npcFk = default, targetFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-addprop-noscript")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var target = mod.Npcs.AddNew("Target"); targetFk = target.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();

        var (orchestrator, manager, changes) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\NoSuchScript\Alpha"] = J("""{"op":"add_property","type":"Int","name":"Alpha","flags":"Edited","value":7}""")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null, "vmad_struct_op");

            Assert.IsType<StageEditResult.RecordNotFound>(result);
            Assert.Empty(changes.GetChanges(formKey: npcFk.ToString()));
        }
    }

    [Fact]
    public void StageEdit_VmadRemoveProperty_StagedAsStructOpCapturingOldValue()
    {
        FormKey npcFk = default, targetFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-removeprop")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var target = mod.Npcs.AddNew("Target"); targetFk = target.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\DefaultScript\IsActive"] = J("""{"op":"remove_property"}""")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null, "vmad_struct_op");

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var change = Assert.Single(staged.Changes);
            Assert.Equal("vmad_struct_op", change.ChangeType);
            // Old value captures the property's current value (true) for revert display.
            Assert.Equal(JsonValueKind.True, change.OldValue.ValueKind);
        }
    }

    // ---- 13.8.2 structural ops: staging add/remove script ----

    [Fact]
    public void StageEdit_VmadAddScript_RecordWithNoVmad_StagedAsStructOp()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("eo-vmad-addscript")
            .WithPlugin("TestPlugin.esp", mod => { npcFk = mod.Npcs.AddNew("PlainNpc").FormKey; })
            .Build();

        var (orchestrator, manager, _) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\NewScript"] = J("""{"op":"add_script","name":"NewScript","flags":"Local","properties":[]}""")
            };

            var result = orchestrator.StageEdit(npcFk.ToString(), "TestPlugin.esp", fields, "user", null, "vmad_struct_op");

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            var change = Assert.Single(staged.Changes);
            Assert.Equal("vmad_struct_op", change.ChangeType);
            Assert.Equal(@"VMAD\NewScript", change.FieldPath);
        }
    }
}
