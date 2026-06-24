using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Changes;

public class PluginWriterVmadTests
{
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // Serializes a per-plugin Raw subtree the way the API does (camelCase) so apply round-trips it.
    private static readonly JsonSerializerOptions _wire = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    // ---- IsReadOnly ----

    [Fact]
    public void IsReadOnly_VmadScalarPath_ReturnsFalse()
    {
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "npc_", @"VMAD\DefaultScript\IsActive"));
    }

    // ---- Helpers ----

    private static VirtualMachineAdapter BuildVmad(FormKey targetFk)
    {
        var vmad = new VirtualMachineAdapter();

        var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });
        script.Properties.Add(new ScriptStringProperty { Name = "Tag", Data = "hello" });

        var objProp = new ScriptObjectProperty { Name = "TargetActor", Alias = -1 };
        objProp.Object.SetTo(targetFk);
        script.Properties.Add(objProp);

        script.Properties.Add(new ScriptIntProperty { Name = "Counter", Data = 42 });
        script.Properties.Add(new ScriptFloatProperty { Name = "Weight", Data = 1.5f });

        vmad.Scripts.Add(script);

        var script2 = new ScriptEntry { Name = "SiblingScript", Flags = ScriptEntry.Flag.Local };
        script2.Properties.Add(new ScriptIntProperty { Name = "SiblingProp", Data = 99 });
        vmad.Scripts.Add(script2);

        return vmad;
    }

    // Returns (pluginPath, npcKey, targetKey, altTargetKey)
    private static (string pluginPath, FormKey npcKey, FormKey targetKey, FormKey altTargetKey, PluginFixtureData data)
        BuildFixture(string prefix)
    {
        FormKey npcFk = default, targetFk = default, altFk = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var target = mod.Npcs.AddNew("TargetNpc");
                targetFk = target.FormKey;
                var alt = mod.Npcs.AddNew("AltTargetNpc");
                altFk = alt.FormKey;
                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();
        return (Path.Combine(fixture.DataFolder, "VmadWrite.esp"), npcFk, targetFk, altFk, fixture);
    }

    private static PendingChange MakeVmadChange(FormKey formKey, string fieldPath, string json) =>
        new(Guid.NewGuid(), formKey.ToString(), "VmadWrite.esp", fieldPath, "npc_",
            JsonDocument.Parse("null").RootElement, J(json), "user", null, DateTime.UtcNow, "field_edit", null);

    private static INpcGetter ReloadNpc(string pluginPath, FormKey npcKey)
    {
        var modPath = new ModPath(ModKey.FromFileName("VmadWrite.esp"), pluginPath);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        return mod.Npcs.First(n => n.FormKey == npcKey);
    }

    // ---- Bool edit ----

    [Fact]
    public async Task SaveAsync_VmadBoolEdit_FlipsValue()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-bool");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path, [MakeVmadChange(npcKey, @"VMAD\DefaultScript\IsActive", "false")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\IsActive", result.Applied);
        Assert.Empty(result.ReadOnly);
        Assert.Empty(result.NotFound);

        var npc = ReloadNpc(path, npcKey);
        var prop = npc.VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptBoolPropertyGetter>().First(p => p.Name == "IsActive");
        Assert.False(prop.Data);
    }

    // ---- String edit ----

    [Fact]
    public async Task SaveAsync_VmadStringEdit_WritesNewString()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-string");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        await writer.SaveAsync(path, [MakeVmadChange(npcKey, @"VMAD\DefaultScript\Tag", "\"world\"")], GameRelease.Fallout4);

        var npc = ReloadNpc(path, npcKey);
        var prop = npc.VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptStringPropertyGetter>().First(p => p.Name == "Tag");
        Assert.Equal("world", prop.Data);
    }

    // ---- Object edit ----

    [Fact]
    public async Task SaveAsync_VmadObjectEdit_WritesNewFormKeyAndAlias()
    {
        var (path, npcKey, _, altTargetKey, fixture) = BuildFixture("vmad-object");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var json = $"{{\"formKey\":\"{altTargetKey}\",\"alias\":5}}";
        await writer.SaveAsync(path, [MakeVmadChange(npcKey, @"VMAD\DefaultScript\TargetActor", json)], GameRelease.Fallout4);

        var npc = ReloadNpc(path, npcKey);
        var prop = npc.VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptObjectPropertyGetter>().First(p => p.Name == "TargetActor");
        Assert.Equal(altTargetKey, prop.Object.FormKey);
        Assert.Equal((short)5, prop.Alias);
    }

    // ---- Round-trip: sibling properties untouched ----

    [Fact]
    public async Task SaveAsync_VmadEdit_SiblingPropertiesAndScriptsUntouched()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-sibling");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Edit one Bool — leave everything else alone
        await writer.SaveAsync(path, [MakeVmadChange(npcKey, @"VMAD\DefaultScript\IsActive", "false")], GameRelease.Fallout4);

        var npc = ReloadNpc(path, npcKey);
        var scripts = npc.VirtualMachineAdapter!.Scripts.ToList();
        Assert.Equal(2, scripts.Count);

        var def = scripts.First(s => s.Name == "DefaultScript");
        Assert.Equal("hello", def.Properties.OfType<IScriptStringPropertyGetter>().First(p => p.Name == "Tag").Data);
        Assert.Equal(42, def.Properties.OfType<IScriptIntPropertyGetter>().First(p => p.Name == "Counter").Data);
        Assert.Equal(1.5f, def.Properties.OfType<IScriptFloatPropertyGetter>().First(p => p.Name == "Weight").Data);

        var sib = scripts.First(s => s.Name == "SiblingScript");
        Assert.Equal(99, sib.Properties.OfType<IScriptIntPropertyGetter>().First(p => p.Name == "SiblingProp").Data);
    }

    // ---- Unknown script or property → NotFound ----

    [Fact]
    public async Task SaveAsync_VmadUnknownScript_AppearsInNotFound()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-notfound-script");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path, [MakeVmadChange(npcKey, @"VMAD\NoSuchScript\IsActive", "false")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\NoSuchScript\IsActive", result.NotFound);
        Assert.Empty(result.Applied);
    }

    [Fact]
    public async Task SaveAsync_VmadUnknownProperty_AppearsInNotFound()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-notfound-prop");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path, [MakeVmadChange(npcKey, @"VMAD\DefaultScript\NoSuchProp", "false")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\NoSuchProp", result.NotFound);
        Assert.Empty(result.Applied);
    }

    // ---- List property apply ----

    [Fact]
    public async Task SaveAsync_VmadArrayOfInt_WritesNewSequence()
    {
        FormKey npcFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-intlist")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ListNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var prop = new ScriptIntListProperty { Name = "Items" };
                prop.Data.Add(1);
                prop.Data.Add(2);
                script.Properties.Add(prop);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Items", "[3, 4, 5]")],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Items", result.Applied);
        Assert.Empty(result.NotFound);

        var npc = ReloadNpc(path, npcFk);
        var saved = npc.VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptIntListPropertyGetter>().First(p => p.Name == "Items");
        Assert.Equal([3, 4, 5], saved.Data.ToList());
    }

    [Fact]
    public async Task SaveAsync_VmadArrayOfString_AddsElement()
    {
        FormKey npcFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-strlist")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ListNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var prop = new ScriptStringListProperty { Name = "Tags" };
                prop.Data.Add("a");
                script.Properties.Add(prop);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Tags", "[\"a\", \"b\"]")],
            GameRelease.Fallout4);

        var npc = ReloadNpc(path, npcFk);
        var saved = npc.VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptStringListPropertyGetter>().First(p => p.Name == "Tags");
        Assert.Equal(2, saved.Data.Count);
        Assert.Equal("b", saved.Data[1]);
    }

    // ---- Object list property apply ----

    [Fact]
    public async Task SaveAsync_VmadArrayOfObject_WritesNewSequence()
    {
        FormKey npcFk = default, fk1 = default, fk2 = default;
        using var fixture = new PluginFixtureBuilder("vmad-objlist")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var a = mod.Npcs.AddNew("A"); fk1 = a.FormKey;
                var b = mod.Npcs.AddNew("B"); fk2 = b.FormKey;
                var npc = mod.Npcs.AddNew("ListNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var prop = new ScriptObjectListProperty { Name = "Targets" };
                var existing = new ScriptObjectProperty { Alias = 0 };
                existing.Object.SetTo(fk1);
                prop.Objects.Add(existing);
                script.Properties.Add(prop);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var json = $"[{{\"formKey\":\"{fk2}\",\"alias\":1}}]";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Targets", json)],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Targets", result.Applied);
        Assert.Empty(result.NotFound);

        var npc = ReloadNpc(path, npcFk);
        var saved = npc.VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptObjectListPropertyGetter>().First(p => p.Name == "Targets");
        var obj = Assert.Single(saved.Objects);
        Assert.Equal(fk2, obj.Object.FormKey);
        Assert.Equal((short)1, obj.Alias);
    }

    [Fact]
    public async Task SaveAsync_VmadObjectEdit_InvalidFormKey_ReturnsNotFound()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-obj-badkey");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcKey, @"VMAD\DefaultScript\TargetActor", "{\"formKey\":\"BADKEY\",\"alias\":0}")],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\TargetActor", result.NotFound);
        Assert.Empty(result.Applied);
    }

    [Fact]
    public async Task SaveAsync_VmadObjectEdit_NullAlias_ReturnsNotFound()
    {
        var (path, npcKey, targetKey, _, fixture) = BuildFixture("vmad-obj-nullalias");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var json = $"{{\"formKey\":\"{targetKey}\",\"alias\":null}}";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcKey, @"VMAD\DefaultScript\TargetActor", json)],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\TargetActor", result.NotFound);
        Assert.Empty(result.Applied);
    }

    // ---- Struct member apply ----

    private static (string path, FormKey npcFk, PluginFixtureData data) BuildStructFixture(string prefix)
    {
        FormKey npcFk = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("StructNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();
                wrapper.Properties.Add(new ScriptFloatProperty { Name = "Factor", Data = 1.5f });
                wrapper.Properties.Add(new ScriptIntProperty { Name = "Count", Data = 3 });
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);

                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        return (Path.Combine(fixture.DataFolder, "VmadWrite.esp"), npcFk, fixture);
    }

    private static IScriptStructPropertyGetter ReloadStruct(string path, FormKey npcFk) =>
        ReloadNpc(path, npcFk).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptStructPropertyGetter>().First(p => p.Name == "Config");

    [Fact]
    public async Task SaveAsync_VmadStructMemberEdit_WritesNewValue()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-edit");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Atomic column: the whole struct subtree is restaged with Factor changed to 2.5.
        var json = """[{"name":"Factor","type":"Float","floatValue":2.5},{"name":"Count","type":"Int","intValue":3}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.Applied);
        Assert.Empty(result.NotFound);

        var members = Assert.Single(ReloadStruct(path, npcFk).Members).Properties;
        Assert.Equal(2.5f, members.OfType<IScriptFloatPropertyGetter>().First(p => p.Name == "Factor").Data);
        Assert.Equal(3, members.OfType<IScriptIntPropertyGetter>().First(p => p.Name == "Count").Data);
    }

    [Fact]
    public async Task SaveAsync_VmadNestedStructMemberEdit_WritesRecursively()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-nested");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Config = { Factor, Count, Inner = { Depth } } — edit the deeply-nested Depth.
        var json = """
            [{"name":"Factor","type":"Float","floatValue":1.5},
             {"name":"Count","type":"Int","intValue":3},
             {"name":"Inner","type":"Struct","members":[{"name":"Depth","type":"Int","intValue":99}]}]
            """;
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.Applied);

        var members = Assert.Single(ReloadStruct(path, npcFk).Members).Properties;
        var inner = members.OfType<IScriptStructPropertyGetter>().First(p => p.Name == "Inner");
        var depth = Assert.Single(inner.Members).Properties
            .OfType<IScriptIntPropertyGetter>().First(p => p.Name == "Depth");
        Assert.Equal(99, depth.Data);
    }

    // ---- ArrayOfStruct apply ----

    private static (string path, FormKey npcFk, PluginFixtureData data) BuildStructListFixture(string prefix)
    {
        FormKey npcFk = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("StructListNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

                var listProp = new ScriptStructListProperty { Name = "Items" };
                var inst0 = new ScriptEntryStructs();
                inst0.Members.Add(new ScriptIntProperty { Name = "Qty", Data = 7 });
                listProp.Structs.Add(inst0);
                script.Properties.Add(listProp);

                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        return (Path.Combine(fixture.DataFolder, "VmadWrite.esp"), npcFk, fixture);
    }

    private static IScriptStructListPropertyGetter ReloadStructList(string path, FormKey npcFk) =>
        ReloadNpc(path, npcFk).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptStructListPropertyGetter>().First(p => p.Name == "Items");

    [Fact]
    public async Task SaveAsync_VmadArrayOfStructMemberEdit_WritesNewValue()
    {
        var (path, npcFk, fixture) = BuildStructListFixture("vmad-structlist-edit");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Atomic column: whole list restaged, element [0]'s Qty changed to 42.
        var json = """[[{"name":"Qty","type":"Int","intValue":42}]]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Items", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Items", result.Applied);
        Assert.Empty(result.NotFound);

        var inst = Assert.Single(ReloadStructList(path, npcFk).Structs);
        Assert.Equal(42, inst.Members.OfType<IScriptIntPropertyGetter>().First(p => p.Name == "Qty").Data);
    }

    [Fact]
    public async Task SaveAsync_VmadArrayOfStruct_AddsElement()
    {
        var (path, npcFk, fixture) = BuildStructListFixture("vmad-structlist-add");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Original list has one element; restage with a second (cloned-shape) element appended.
        var json = """[[{"name":"Qty","type":"Int","intValue":7}],[{"name":"Qty","type":"Int","intValue":0}]]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Items", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Items", result.Applied);

        var structs = ReloadStructList(path, npcFk).Structs;
        Assert.Equal(2, structs.Count);
        Assert.Equal(7, structs[0].Members.OfType<IScriptIntPropertyGetter>().First(p => p.Name == "Qty").Data);
        Assert.Equal(0, structs[1].Members.OfType<IScriptIntPropertyGetter>().First(p => p.Name == "Qty").Data);
    }

    // ---- Round-trip byte-stability ----

    [Fact]
    public async Task SaveAsync_VmadStructRoundTrip_IsByteStable()
    {
        // Two identical fixtures: one saved untouched (Mutagen passthrough), one with the struct
        // restaged from its own classifier-derived Raw value. Our rebuild must match byte-for-byte.
        static (string path, FormKey npc, PluginFixtureData data) BuildRich(string prefix)
        {
            FormKey npcFk = default, targetFk = default;
            var fixture = new PluginFixtureBuilder(prefix)
                .WithPlugin("VmadWrite.esp", mod =>
                {
                    var target = mod.Npcs.AddNew("RefTarget");
                    targetFk = target.FormKey;
                    var npc = mod.Npcs.AddNew("RichStructNpc");
                    npcFk = npc.FormKey;

                    var vmad = new VirtualMachineAdapter();
                    var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                    var structProp = new ScriptStructProperty { Name = "Config" };
                    var wrapper = new ScriptEntry();
                    wrapper.Properties.Add(new ScriptFloatProperty { Name = "Factor", Data = 1.5f });
                    wrapper.Properties.Add(new ScriptIntProperty { Name = "Count", Data = 3 });
                    var objMember = new ScriptObjectProperty { Name = "Ref", Alias = -1 };
                    objMember.Object.SetTo(targetFk);
                    wrapper.Properties.Add(objMember);
                    var inner = new ScriptStructProperty { Name = "Inner" };
                    var innerWrapper = new ScriptEntry();
                    innerWrapper.Properties.Add(new ScriptIntProperty { Name = "Depth", Data = 42 });
                    inner.Members.Add(innerWrapper);
                    wrapper.Properties.Add(inner);
                    structProp.Members.Add(wrapper);
                    script.Properties.Add(structProp);
                    vmad.Scripts.Add(script);
                    npc.VirtualMachineAdapter = vmad;
                })
                .Build();
            return (Path.Combine(fixture.DataFolder, "VmadWrite.esp"), npcFk, fixture);
        }

        var (pathA, npcA, fxA) = BuildRich("vmad-bytes-a");
        var (pathB, npcB, fxB) = BuildRich("vmad-bytes-b");
        using var _a = fxA;
        using var _b = fxB;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Derive the struct's Raw subtree the way the compare endpoint does.
        var ddl = new TableDdlBuilder(_reflector);
        using var repo = new DuckDbRecordRepository(_reflector, ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(ModKey.FromFileName("VmadWrite.esp"), pathA);
        repo.Index((IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4), 0);
        repo.UpdateWinners();
        var vmadData = repo.GetVmad(npcA.ToString(), "VmadWrite.esp");
        var compare = VmadConflictClassifier.Classify([new VmadPluginInput("VmadWrite.esp", 0, vmadData)]);
        var rawConfig = compare.Compare.Scripts[0].Properties.First(p => p.Name == "Config").Raw!["VmadWrite.esp"];

        // A: passthrough save. B: restage the struct from its own Raw.
        await writer.SaveAsync(pathA, [], GameRelease.Fallout4);
        var resultB = await writer.SaveAsync(pathB,
            [MakeVmadChange(npcB, @"VMAD\DefaultScript\Config", JsonSerializer.Serialize(rawConfig, _wire))],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", resultB.Applied);   // restage actually ran
        Assert.Equal(await File.ReadAllBytesAsync(pathA), await File.ReadAllBytesAsync(pathB));
    }

    // ---- Struct member type coverage (Bool, String, Object alias, invalid nodes) ----

    [Fact]
    public async Task SaveAsync_VmadStructBoolMember_WritesBoolValue()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-bool");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var json = """[{"name":"Flag","type":"Bool","boolValue":true}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.Applied);
        var members = Assert.Single(ReloadStruct(path, npcFk).Members).Properties;
        Assert.True(members.OfType<IScriptBoolPropertyGetter>().First(p => p.Name == "Flag").Data);
    }

    [Fact]
    public async Task SaveAsync_VmadStructStringMember_WritesStringValue()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-string");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var json = """[{"name":"Label","type":"String","stringValue":"hello"}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.Applied);
        var members = Assert.Single(ReloadStruct(path, npcFk).Members).Properties;
        Assert.Equal("hello", members.OfType<IScriptStringPropertyGetter>().First(p => p.Name == "Label").Data);
    }

    [Fact]
    public async Task SaveAsync_VmadStructObjectMember_MissingAlias_DefaultsToZero()
    {
        FormKey targetFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-struct-obj-alias")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var target = mod.Npcs.AddNew("ObjTarget");
                targetFk = target.FormKey;
                var npc = mod.Npcs.AddNew("ObjAlias");
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();
                var obj = new ScriptObjectProperty { Name = "Ref", Alias = 5 };
                obj.Object.SetTo(target.FormKey);
                wrapper.Properties.Add(obj);
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var npcFk = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("VmadWrite.esp"), path), Fallout4Release.Fallout4)
            .Npcs.First(n => n.EditorID == "ObjAlias").FormKey;

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        // No "aliasValue" key — should default alias to 0
        var json = $$"""[{"name":"Ref","type":"Object","formKeyValue":"{{targetFk}}"}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.Applied);
        var members = Assert.Single(ReloadNpc(path, npcFk).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptStructPropertyGetter>().First(p => p.Name == "Config").Members).Properties;
        Assert.Equal((short)0, members.OfType<IScriptObjectPropertyGetter>().First(p => p.Name == "Ref").Alias);
    }

    [Fact]
    public async Task SaveAsync_VmadStructMember_InvalidFormKey_ReturnsNotFound()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-badfk");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var json = """[{"name":"Ref","type":"Object","formKeyValue":"not-a-formkey"}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.NotFound);
    }

    [Fact]
    public async Task SaveAsync_VmadStructMember_InvalidNodeType_ReturnsNotFound()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-badtype");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Missing name field → TryBuildMemberProperty returns false
        var json = """[{"type":"Int","intValue":1}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.NotFound);
    }

    [Fact]
    public async Task SaveAsync_VmadStructMember_UnrecognizedType_ReturnsNotFound()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-unknowntype");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Type "Unknown" hits the default: return false branch
        var json = """[{"name":"X","type":"Unknown"}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.NotFound);
    }

    [Fact]
    public async Task SaveAsync_VmadStructMember_NonArrayMembers_ReturnsNotFound()
    {
        var (path, npcFk, fixture) = BuildStructFixture("vmad-struct-nonarray");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Struct member with "members" as a string (not array) → TryBuildMembers returns false
        var json = """[{"name":"Inner","type":"Struct","members":"oops"}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.NotFound);
    }

    [Fact]
    public async Task SaveAsync_VmadStructObjectMember_NonNumberAlias_DefaultsToZero()
    {
        // aliasValue present but is a string — not a Number → condition false → alias=0
        FormKey targetFk = default, npcFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-struct-alias-str")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var target = mod.Npcs.AddNew("ObjTarget2"); targetFk = target.FormKey;
                var npc = mod.Npcs.AddNew("StructNpcAlias"); npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();
                var obj = new ScriptObjectProperty { Name = "Ref", Alias = 5 };
                obj.Object.SetTo(target.FormKey);
                wrapper.Properties.Add(obj);
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var json = $$"""[{"name":"Ref","type":"Object","formKeyValue":"{{targetFk}}","aliasValue":"five"}]""";
        var result = await writer.SaveAsync(path,
            [MakeVmadChange(npcFk, @"VMAD\DefaultScript\Config", json)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Config", result.Applied);
        var members = Assert.Single(ReloadNpc(path, npcFk).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptStructPropertyGetter>().First(p => p.Name == "Config").Members).Properties;
        Assert.Equal((short)0, members.OfType<IScriptObjectPropertyGetter>().First(p => p.Name == "Ref").Alias);
    }

    // ---- Record with no VMAD → NotFound ----

    [Fact]
    public async Task SaveAsync_VmadEdit_RecordHasNoVmad_AppearsInNotFound()
    {
        FormKey npcFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-no-vmad")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("PlainNpc");
                npcFk = npc.FormKey;
            })
            .Build();

        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path, [MakeVmadChange(npcFk, @"VMAD\DefaultScript\IsActive", "false")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\IsActive", result.NotFound);
        Assert.Empty(result.Applied);
    }

    // ---- 13.8.1 structural ops: add/remove property ----

    private static PendingChange MakeStructOp(FormKey formKey, string fieldPath, string opJson) =>
        new(Guid.NewGuid(), formKey.ToString(), "VmadWrite.esp", fieldPath, "npc_",
            JsonDocument.Parse("null").RootElement, J(opJson), "user", null, DateTime.UtcNow, "vmad_struct_op", null);

    [Fact]
    public async Task SaveAsync_VmadAddProperty_Scalar_AddsAndKeepsSorted()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-add-prop");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var op = """{"op":"add_property","type":"Int","name":"Alpha","flags":"Edited","value":7}""";
        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\DefaultScript\Alpha", op)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Alpha", result.Applied);
        Assert.Empty(result.NotFound);

        var props = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties;
        var added = props.OfType<IScriptIntPropertyGetter>().First(p => p.Name == "Alpha");
        Assert.Equal(7, added.Data);

        var names = props.Select(p => p.Name).ToList();
        Assert.Equal(names.OrderBy(n => n, StringComparer.OrdinalIgnoreCase), names);
    }

    [Fact]
    public async Task SaveAsync_VmadAddProperty_Object_WritesFormKey()
    {
        var (path, npcKey, targetKey, _, fixture) = BuildFixture("vmad-add-obj");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var op = $$$"""{"op":"add_property","type":"Object","name":"NewRef","flags":"Edited","value":{"formKey":"{{{targetKey}}}","alias":3}}""";
        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\DefaultScript\NewRef", op)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\NewRef", result.Applied);
        var added = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptObjectPropertyGetter>().First(p => p.Name == "NewRef");
        Assert.Equal(targetKey, added.Object.FormKey);
        Assert.Equal((short)3, added.Alias);
    }

    [Fact]
    public async Task SaveAsync_VmadRemoveProperty_RemovesAndKeepsSiblings()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-remove-prop");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\DefaultScript\Tag", """{"op":"remove_property"}""")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Tag", result.Applied);
        var props = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties;
        Assert.DoesNotContain(props, p => p.Name == "Tag");
        Assert.Contains(props, p => p.Name == "IsActive");
        Assert.Contains(props, p => p.Name == "Counter");
    }

    // ---- 13.8.2 structural ops: add/remove script ----

    [Fact]
    public async Task SaveAsync_VmadAddScript_RecordHasNoVmad_CreatesAdapterWithScript()
    {
        FormKey npcFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-addscript-novmad")
            .WithPlugin("VmadWrite.esp", mod => { npcFk = mod.Npcs.AddNew("PlainNpc").FormKey; })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var op = """{"op":"add_script","name":"NewScript","flags":"Local","properties":[]}""";
        var result = await writer.SaveAsync(path, [MakeStructOp(npcFk, @"VMAD\NewScript", op)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\NewScript", result.Applied);
        var vmad = ReloadNpc(path, npcFk).VirtualMachineAdapter;
        Assert.NotNull(vmad);
        Assert.Equal(2, vmad!.ObjectFormat);
        Assert.Contains(vmad.Scripts, s => s.Name == "NewScript");
    }

    [Fact]
    public async Task SaveAsync_VmadAddScript_ExistingVmad_AddsSortedByName()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-addscript-existing");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var op = """{"op":"add_script","name":"AAAScript","flags":"Local","properties":[]}""";
        var result = await writer.SaveAsync(path, [MakeStructOp(npcKey, @"VMAD\AAAScript", op)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\AAAScript", result.Applied);
        var names = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts.Select(s => s.Name).ToList();
        Assert.Contains("AAAScript", names);
        // Existing scripts must survive — the adapter is reused, not recreated.
        Assert.Contains("DefaultScript", names);
        Assert.Contains("SiblingScript", names);
        Assert.Equal(names.OrderBy(n => n, StringComparer.OrdinalIgnoreCase), names);
    }

    [Fact]
    public async Task SaveAsync_VmadAddScript_ExistingName_ReplacesAndKeepsOthers()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-addscript-dup");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        // Re-adding an existing script name replaces it (single entry) and leaves siblings intact.
        var op = """{"op":"add_script","name":"DefaultScript","flags":"Inherited","properties":[]}""";
        var result = await writer.SaveAsync(path, [MakeStructOp(npcKey, @"VMAD\DefaultScript", op)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript", result.Applied);
        var scripts = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts;
        Assert.Single(scripts, s => s.Name == "DefaultScript");
        Assert.Equal(ScriptEntry.Flag.Inherited, scripts.First(s => s.Name == "DefaultScript").Flags);
        Assert.Contains(scripts, s => s.Name == "SiblingScript");
    }

    [Fact]
    public async Task SaveAsync_VmadRemoveScript_RemovesAndKeepsSiblings()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-removescript");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\SiblingScript", """{"op":"remove_script"}""")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\SiblingScript", result.Applied);
        var scripts = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts;
        Assert.DoesNotContain(scripts, s => s.Name == "SiblingScript");
        Assert.Contains(scripts, s => s.Name == "DefaultScript");
    }

    [Fact]
    public async Task SaveAsync_VmadRemoveLastScript_RetainsEmptyAdapter()
    {
        FormKey npcFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-removelastscript")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("OneScriptNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                vmad.Scripts.Add(new ScriptEntry { Name = "OnlyScript", Flags = ScriptEntry.Flag.Local });
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcFk, @"VMAD\OnlyScript", """{"op":"remove_script"}""")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\OnlyScript", result.Applied);
        var vmad = ReloadNpc(path, npcFk).VirtualMachineAdapter;
        Assert.NotNull(vmad);
        Assert.Empty(vmad!.Scripts);
    }

    // ---- 13.8.3 structural op: change property type ----

    [Fact]
    public async Task SaveAsync_VmadSetType_ReplacesWithDefaultValuedNewType()
    {
        // "Counter" is an Int property (Data 42) in BuildVmad; retype it to Float → default 0, Name kept.
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-settype");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\DefaultScript\Counter", """{"op":"set_type","type":"Float"}""")],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Counter", result.Applied);
        var prop = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties.First(p => p.Name == "Counter");
        var floatProp = Assert.IsAssignableFrom<IScriptFloatPropertyGetter>(prop);
        Assert.Equal(0f, floatProp.Data);
    }

    [Fact]
    public async Task SaveAsync_VmadSetType_PreservesFlags()
    {
        FormKey npcFk = default;
        using var fixture = new PluginFixtureBuilder("vmad-settype-flags")
            .WithPlugin("VmadWrite.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("FlagNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                script.Properties.Add(new ScriptIntProperty { Name = "P", Data = 5, Flags = ScriptProperty.Flag.Removed });
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "VmadWrite.esp");
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        await writer.SaveAsync(path,
            [MakeStructOp(npcFk, @"VMAD\DefaultScript\P", """{"op":"set_type","type":"Bool"}""")],
            GameRelease.Fallout4);

        var prop = ReloadNpc(path, npcFk).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties.First(p => p.Name == "P");
        Assert.IsAssignableFrom<IScriptBoolPropertyGetter>(prop);
        Assert.Equal(ScriptProperty.Flag.Removed, prop.Flags);
    }

    // ---- 13.8.4 structural op: set flags ----

    [Fact]
    public async Task SaveAsync_VmadSetPropertyFlags_WritesFlags()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-setpropflags");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\DefaultScript\Counter", """{"op":"set_flags","flags":"Removed"}""")],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Counter", result.Applied);
        var prop = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties.First(p => p.Name == "Counter");
        Assert.Equal(ScriptProperty.Flag.Removed, prop.Flags);
    }

    [Fact]
    public async Task SaveAsync_VmadSetScriptFlags_WritesFlags()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-setscriptflags");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\DefaultScript", """{"op":"set_flags","flags":"Inherited"}""")],
            GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript", result.Applied);
        var script = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts.First(s => s.Name == "DefaultScript");
        Assert.Equal(ScriptEntry.Flag.Inherited, script.Flags);
    }

    // ---- 13.8 structural ops: target-not-found → NotFound (no throw) ----

    [Theory]
    [InlineData(@"VMAD\NoScript\X", """{"op":"remove_property"}""")]      // missing script (property op)
    [InlineData(@"VMAD\NoScript\X", """{"op":"set_type","type":"Int"}""")]
    [InlineData(@"VMAD\DefaultScript\NoProp", """{"op":"remove_property"}""")] // missing property
    [InlineData(@"VMAD\DefaultScript\NoProp", """{"op":"set_type","type":"Int"}""")]
    [InlineData(@"VMAD\DefaultScript\NoProp", """{"op":"set_flags","flags":"Removed"}""")]
    [InlineData(@"VMAD\NoScript", """{"op":"remove_script"}""")]          // missing script (script op)
    [InlineData(@"VMAD\NoScript", """{"op":"set_flags","flags":"Local"}""")]
    public async Task SaveAsync_VmadStructOp_MissingTarget_ReturnsNotFound(string fieldPath, string op)
    {
        var (path, npcKey, _, _, fixture) = BuildFixture($"vmad-missing-{Guid.NewGuid():N}");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path, [MakeStructOp(npcKey, fieldPath, op)], GameRelease.Fallout4);

        Assert.Contains(fieldPath, result.NotFound);
        Assert.Empty(result.Applied);
    }

    [Fact]
    public async Task SaveAsync_VmadAddProperty_ExistingName_ReplacesInPlace()
    {
        // "Counter" is an existing Int; re-adding it as Float must replace (single entry, new value).
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-addprop-dup");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var op = """{"op":"add_property","type":"Float","name":"Counter","flags":"Edited","value":2.5}""";
        var result = await writer.SaveAsync(path, [MakeStructOp(npcKey, @"VMAD\DefaultScript\Counter", op)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Counter", result.Applied);
        var props = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties.Where(p => p.Name == "Counter").ToList();
        Assert.Single(props);
        Assert.Equal(2.5f, Assert.IsAssignableFrom<IScriptFloatPropertyGetter>(props[0]).Data);
    }

    [Fact]
    public async Task SaveAsync_VmadRemoveProperty_FirstProperty_Removed()
    {
        // "IsActive" is the first property (index 0) — exercises the RemoveByName loop's lower bound.
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-remove-first");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeStructOp(npcKey, @"VMAD\DefaultScript\IsActive", """{"op":"remove_property"}""")], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\IsActive", result.Applied);
        var props = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties;
        Assert.DoesNotContain(props, p => p.Name == "IsActive");
    }

    [Fact]
    public async Task SaveAsync_VmadAddProperty_String_WritesValue()
    {
        var (path, npcKey, _, _, fixture) = BuildFixture("vmad-addprop-string");
        using var _ = fixture;
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);

        var op = """{"op":"add_property","type":"String","name":"Label","flags":"Edited","value":"hi"}""";
        var result = await writer.SaveAsync(path, [MakeStructOp(npcKey, @"VMAD\DefaultScript\Label", op)], GameRelease.Fallout4);

        Assert.Contains(@"VMAD\DefaultScript\Label", result.Applied);
        var prop = ReloadNpc(path, npcKey).VirtualMachineAdapter!.Scripts
            .First(s => s.Name == "DefaultScript").Properties
            .OfType<IScriptStringPropertyGetter>().First(p => p.Name == "Label");
        Assert.Equal("hi", prop.Data);
    }
}
