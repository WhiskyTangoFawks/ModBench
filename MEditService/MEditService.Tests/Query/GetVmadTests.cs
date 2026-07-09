using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

public sealed class GetVmadTests : IDisposable
{
    private static readonly ISchemaReflector Reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private readonly FormKey _npcFormKey;
    private readonly FormKey _targetFormKey;
    private readonly FormKey _plainNpcFormKey;
    private readonly PluginFixtureData _fixture;

    public GetVmadTests()
    {
        FormKey npcFk = default, targetFk = default, plainFk = default;
        _fixture = new PluginFixtureBuilder()
            .WithPlugin("VmadQuery.esp", mod =>
            {
                var target = mod.Npcs.AddNew("Target");
                targetFk = target.FormKey;

                var plain = mod.Npcs.AddNew("PlainNpc"); // no VMAD
                plainFk = plain.FormKey;

                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                npc.VirtualMachineAdapter = BuildVmad(target.FormKey);
            })
            .Build();
        _npcFormKey = npcFk;
        _targetFormKey = targetFk;
        _plainNpcFormKey = plainFk;
    }

    private static VirtualMachineAdapter BuildVmad(FormKey targetFk)
    {
        var vmad = new VirtualMachineAdapter();
        var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

        script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });

        var objProp = new ScriptObjectProperty { Name = "TargetActor", Alias = -1 };
        objProp.Object.SetTo(targetFk);
        script.Properties.Add(objProp);

        script.Properties.Add(new ScriptFloatProperty { Name = "Weight", Data = 2.5f });
        script.Properties.Add(new ScriptStringProperty { Name = "Tag", Data = "hello" });

        var intList = new ScriptIntListProperty { Name = "Scores" };
        intList.Data.Add(10);
        intList.Data.Add(20);
        intList.Data.Add(30);
        script.Properties.Add(intList);

        var boolList = new ScriptBoolListProperty { Name = "Bits" };
        boolList.Data.Add(true);
        boolList.Data.Add(false);
        script.Properties.Add(boolList);

        var floatList = new ScriptFloatListProperty { Name = "Mults" };
        floatList.Data.Add(1.5f);
        floatList.Data.Add(2.5f);
        script.Properties.Add(floatList);

        var stringList = new ScriptStringListProperty { Name = "Names" };
        stringList.Data.Add("a");
        stringList.Data.Add("b");
        script.Properties.Add(stringList);

        var objList = new ScriptObjectListProperty { Name = "Targets" };
        var objElem = new ScriptObjectProperty { Alias = 2 };
        objElem.Object.SetTo(targetFk);
        objList.Objects.Add(objElem);
        script.Properties.Add(objList);

        var structProp = new ScriptStructProperty { Name = "Config" };
        var member = new ScriptEntry { Name = "SubScript" };
        member.Properties.Add(new ScriptFloatProperty { Name = "Factor", Data = 1.5f });
        var innerStruct = new ScriptStructProperty { Name = "Inner" };
        var innerWrapper = new ScriptEntry();
        innerWrapper.Properties.Add(new ScriptIntProperty { Name = "Depth", Data = 42 });
        innerStruct.Members.Add(innerWrapper);
        member.Properties.Add(innerStruct);
        structProp.Members.Add(member);
        script.Properties.Add(structProp);

        var structList = new ScriptStructListProperty { Name = "Items" };
        var inst = new ScriptEntryStructs();
        inst.Members.Add(new ScriptIntProperty { Name = "Qty", Data = 7 });
        structList.Structs.Add(inst);
        script.Properties.Add(structList);

        vmad.Scripts.Add(script);
        return vmad;
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordRepository LoadedRepository()
    {
        var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName("VmadQuery.esp"),
            Path.Combine(_fixture.DataFolder, "VmadQuery.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();
        return repo;
    }

    [Fact]
    public void GetVmad_ReturnsScript_WithBoolProperty()
    {
        using var repo = LoadedRepository();

        var vmad = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp");

        Assert.NotNull(vmad);
        var script = Assert.Single(vmad!.Scripts);
        Assert.Equal("DefaultScript", script.Name);
        Assert.Equal("Local", script.Flags);
        Assert.Equal("IsActive", script.Properties[0].Name); // properties returned in property_index order

        var (name, value) = script.Properties.First(p => p.Name == "IsActive");
        Assert.Equal("IsActive", name);
        Assert.Equal("Bool", value.Type);
        Assert.Equal(true, value.Value);
    }

    [Fact]
    public void GetVmad_ReturnsObjectProperty_WithFormKeyAndAlias()
    {
        using var repo = LoadedRepository();

        var vmad = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp");

        var prop = vmad!.Scripts[0].Properties.First(p => p.Name == "TargetActor").Value;
        Assert.Equal("Object", prop.Type);
        Assert.Equal(_targetFormKey.ToString(), prop.Value);
        Assert.Equal((short)-1, prop.Alias);
    }

    [Fact]
    public void GetVmad_ReconstructsScalarArray_InOrder()
    {
        using var repo = LoadedRepository();

        var vmad = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp");

        var prop = vmad!.Scripts[0].Properties.First(p => p.Name == "Scores").Value;
        Assert.Equal("ArrayOfInt", prop.Type);
        Assert.NotNull(prop.ListItems);
        Assert.Equal(new object?[] { 10, 20, 30 }, prop.ListItems!.Select(i => i.Value));
    }

    [Fact]
    public void GetVmad_ReconstructsStructMembers_FromStructJson()
    {
        using var repo = LoadedRepository();

        var vmad = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp");

        var config = vmad!.Scripts[0].Properties.First(p => p.Name == "Config").Value;
        Assert.Equal("Struct", config.Type);
        Assert.NotNull(config.Members);

        // Struct fields surface as named members (the unnamed binary ScriptEntry wrapper is flattened away).
        var factor = config.Members!.First(m => m.Name == "Factor").Value;
        Assert.Equal("Float", factor.Type);
        Assert.Equal(1.5f, factor.Value);
    }

    [Fact]
    public void GetVmad_ReconstructsNestedStructMember_Recursively()
    {
        using var repo = LoadedRepository();

        var config = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp")!.Scripts[0].Properties
            .First(p => p.Name == "Config").Value;

        var inner = config.Members!.First(m => m.Name == "Inner").Value;
        Assert.Equal("Struct", inner.Type);
        Assert.NotNull(inner.Members);

        var depth = inner.Members!.First(m => m.Name == "Depth").Value;
        Assert.Equal("Int", depth.Type);
        Assert.Equal(42, depth.Value);
    }

    [Fact]
    public void GetVmad_MapsFloatAndStringScalars()
    {
        using var repo = LoadedRepository();
        var props = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp")!.Scripts[0].Properties;

        var weight = props.First(p => p.Name == "Weight").Value;
        Assert.Equal("Float", weight.Type);
        Assert.Equal(2.5f, weight.Value);

        var tag = props.First(p => p.Name == "Tag").Value;
        Assert.Equal("String", tag.Type);
        Assert.Equal("hello", tag.Value);
    }

    [Fact]
    public void GetVmad_MapsAllScalarArrayElementTypes()
    {
        using var repo = LoadedRepository();
        var props = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp")!.Scripts[0].Properties;

        Assert.Equal(new object?[] { true, false }, props.First(p => p.Name == "Bits").Value.ListItems!.Select(i => i.Value));
        Assert.Equal(new object?[] { 1.5f, 2.5f }, props.First(p => p.Name == "Mults").Value.ListItems!.Select(i => i.Value));
        Assert.Equal(new object?[] { "a", "b" }, props.First(p => p.Name == "Names").Value.ListItems!.Select(i => i.Value));

        var target = Assert.Single(props.First(p => p.Name == "Targets").Value.ListItems!);
        Assert.Equal("Object", target.Type);
        Assert.Equal(_targetFormKey.ToString(), target.Value);
        Assert.Equal((short)2, target.Alias);
    }

    [Fact]
    public void GetVmad_ReconstructsArrayOfStruct_FromStructJson()
    {
        using var repo = LoadedRepository();
        var items = repo.GetVmad(_npcFormKey.ToString(), "VmadQuery.esp")!.Scripts[0].Properties
            .First(p => p.Name == "Items").Value;

        Assert.Equal("ArrayOfStruct", items.Type);
        var instance = Assert.Single(items.StructList!);
        var qty = instance.First(m => m.Name == "Qty").Value;
        Assert.Equal("Int", qty.Type);
        Assert.Equal(7, qty.Value);
    }

    [Fact]
    public void GetVmad_ReturnsNull_WhenRecordHasNoVmad()
    {
        using var repo = LoadedRepository();

        Assert.Null(repo.GetVmad(_plainNpcFormKey.ToString(), "VmadQuery.esp"));
    }

    [Fact]
    public void GetVmad_EmptyArrayProperty_ReturnsEmptyListItems()
    {
        // MapVmadItems(null): when a list-type property has 0 items in DB,
        // GetValueOrDefault returns null → MapVmadItems must return [] not throw.
        FormKey emptyListFk = default;
        using var emptyListFixture = new PluginFixtureBuilder()
            .WithPlugin("VmadEmptyList.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("EmptyListNpc");
                emptyListFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "S", Flags = ScriptEntry.Flag.Local };
                script.Properties.Add(new ScriptIntListProperty { Name = "Empty" }); // 0 items
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName("VmadEmptyList.esp"),
            Path.Combine(emptyListFixture.DataFolder, "VmadEmptyList.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();

        using (repo)
        {
            var vmad = repo.GetVmad(emptyListFk.ToString(), "VmadEmptyList.esp");
            Assert.NotNull(vmad);
            var emptyProp = vmad!.Scripts[0].Properties.First(p => p.Name == "Empty").Value;
            Assert.Equal("ArrayOfInt", emptyProp.Type);
            Assert.NotNull(emptyProp.ListItems);
            Assert.Empty(emptyProp.ListItems!);
        }
    }
}
